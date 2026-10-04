import { describe, expect, it } from 'vitest';
import { eid, loadConfig, setup } from './helpers.js';

const now = () => new Date().toISOString();

describe('event ingestion', () => {
  it('deduplicates by event_id across retries and within a batch', async () => {
    const { api, db } = setup();
    const s = (await api.post('/api/sessions').send({})).body.session;
    const batch = {
      events: [
        { event_id: eid(), session_id: s.id, name: 'step_viewed', step_id: 'intro', client_timestamp: now() },
        { event_id: eid(), session_id: s.id, name: 'step_completed', step_id: 'intro', client_timestamp: now(), properties: { next_step_id: 'team_size' } },
      ],
    };
    batch.events.push({ ...batch.events[0] }); // duplicate inside the same batch
    const first = (await api.post('/api/events').send(batch)).body;
    expect(first.accepted).toHaveLength(2);
    expect(first.duplicates).toHaveLength(1);

    // retry after a "timeout": same batch again → nothing new is stored
    const retry = (await api.post('/api/events').send(batch)).body;
    expect(retry.accepted).toHaveLength(0);
    expect(retry.duplicates).toHaveLength(3);
    const { c } = db.prepare('SELECT COUNT(*) c FROM events WHERE session_id = ?').get(s.id) as { c: number };
    expect(c).toBe(3); // session_started + 2
  });

  it('rejects bad events individually without breaking the rest of the batch', async () => {
    const { api } = setup();
    const s = (await api.post('/api/sessions').send({})).body.session;
    const good = { event_id: eid(), session_id: s.id, name: 'step_viewed', step_id: 'intro', client_timestamp: now() };
    const res = await api.post('/api/events').send({
      events: [
        null,
        { ...good, event_id: 'x' },
        { ...good, event_id: eid(), session_id: 'nope' },
        { ...good, event_id: eid(), name: 'made_up' },
        { ...good, event_id: eid(), name: 'session_started' },
        { ...good, event_id: eid(), step_id: 'meeting_hours' }, // not in v1
        { ...good, event_id: eid(), client_timestamp: 'yesterday' },
        { ...good, event_id: eid(), funnel_version: 2 },
        { ...good, event_id: eid(), name: 'recommendation_expanded', step_id: 'result' }, // only exists from v3
        good,
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([good.event_id]);
    expect(res.body.rejected.map((r: { reason: string }) => r.reason)).toEqual([
      'not_an_object',
      'invalid_event_id',
      'unknown_session',
      'event_not_allowed_in_v1',
      'server_only_event',
      'unknown_step_id',
      'invalid_client_timestamp',
      'version_mismatch',
      'event_not_allowed_in_v1',
    ]);
  });

  it('accepts the new v3 event only for v3 sessions, without any schema change', async () => {
    const { api } = setup();
    const v1 = (await api.post('/api/sessions').send({})).body.session;
    await api.post('/api/admin/versions?publish=true').send(loadConfig(3));
    const v3 = (await api.post('/api/sessions').send({})).body.session;
    const ev = (sid: string) => ({ event_id: eid(), session_id: sid, name: 'recommendation_expanded', step_id: 'result', client_timestamp: now(), properties: { result_id: 'balanced', action: 'expand_recommendation', source: 'cta' } });
    const res = (await api.post('/api/events').send({ events: [ev(v1.id), ev(v3.id)] })).body;
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected[0].reason).toBe('event_not_allowed_in_v1');
  });

  it('drops properties that are not declared for the event (no raw answers in analytics)', async () => {
    const { api, db } = setup();
    const s = (await api.post('/api/sessions').send({})).body.session;
    const id = eid();
    await api.post('/api/events').send({
      events: [{ event_id: id, session_id: s.id, name: 'answer_submitted', step_id: 'team_size', client_timestamp: now(), properties: { answer_kind: 'number', value: 42, email: 'x@y.z' } }],
    });
    const row = db.prepare('SELECT properties FROM events WHERE event_id = ?').get(id) as { properties: string };
    expect(JSON.parse(row.properties)).toEqual({ answer_kind: 'number' });
  });

  it('rejects malformed envelopes and oversize batches', async () => {
    const { api } = setup();
    expect((await api.post('/api/events').send({ nope: 1 })).status).toBe(400);
    expect((await api.post('/api/events').send({ events: Array(501).fill({}) })).status).toBe(413);
  });
});
