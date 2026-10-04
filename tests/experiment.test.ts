import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { pickVariant } from '../shared/engine.js';
import { loadConfig } from './helpers.js';

describe('A/B assignment', () => {
  it('is stable for a session across resumes (refresh)', async () => {
    const { api } = setup();
    const first = (await api.post('/api/sessions').send({})).body;
    for (let i = 0; i < 5; i++) {
      const again = (await api.post('/api/sessions').send({ sessionId: first.session.id })).body;
      expect(again.session.id).toBe(first.session.id);
      expect(again.session.variant).toBe(first.session.variant);
      expect(again.funnel.variant).toBe(first.session.variant);
    }
  });

  it('is deterministic per session id and roughly follows the weights', () => {
    const cfg = loadConfig(1);
    expect(pickVariant(cfg, 'abc')).toBe(pickVariant(cfg, 'abc'));
    const counts: Record<string, number> = { A: 0, B: 0 };
    for (let i = 0; i < 4000; i++) counts[pickVariant(cfg, `session-${i}`)]++;
    expect(counts.A / 4000).toBeGreaterThan(0.45);
    expect(counts.A / 4000).toBeLessThan(0.55);
  });

  it('honours the ?variant override and only sends the assigned variant to the client', async () => {
    const { api } = setup();
    const b = (await api.post('/api/sessions').send({ variant: 'B' })).body;
    expect(b.session.variant).toBe('B');
    expect(b.session.variantSource).toBe('override');
    expect(b.funnel.steps[1].id).toBe('work_mode'); // B order
    expect(b.funnel.steps[0].content.title).toBe('How should your team really work?'); // B copy
    expect(JSON.stringify(b.funnel)).not.toContain('stepSequence');

    // same override → same session; different override → new session (variant never mutates)
    expect((await api.post('/api/sessions').send({ sessionId: b.session.id, variant: 'B' })).body.session.id).toBe(b.session.id);
    const a = (await api.post('/api/sessions').send({ sessionId: b.session.id, variant: 'A' })).body;
    expect(a.created).toBe(true);
    expect(a.session.variant).toBe('A');
    expect((await api.post('/api/sessions').send({ variant: 'Z' })).status).toBe(400);
  });

  it('stamps version and variant on every event, including the server-side session_started', async () => {
    const { api, db } = setup();
    const s = (await api.post('/api/sessions').send({ variant: 'B', utm: { utm_campaign: 'spring' } })).body.session;
    await api.post('/api/events').send({
      events: [{ event_id: 'e-stamp-0001', session_id: s.id, name: 'step_viewed', step_id: 'intro', client_timestamp: new Date().toISOString() }],
    });
    const rows = db.prepare('SELECT name, funnel_version, variant, utm_campaign FROM events WHERE session_id = ?').all(s.id) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ funnel_version: 1, variant: 'B', utm_campaign: 'spring' });
  });
});
