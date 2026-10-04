import { describe, expect, it } from 'vitest';
import { coreMetrics, stepFunnel, twoProportionTest, type EventRow } from '../server/analytics.js';
import { eid, setup } from './helpers.js';

const seq = [
  { id: 'intro', type: 'info', conditional: false },
  { id: 'q1', type: 'single-select', conditional: false },
  { id: 'q2', type: 'number', conditional: true },
  { id: 'q3', type: 'number', conditional: false },
  { id: 'result', type: 'result', conditional: false },
];
const ev = (session_id: string, name: string, step_id: string | null = null): EventRow => ({
  session_id, name, step_id, funnel_version: 1, variant: 'A', utm_campaign: null,
});

describe('analytics aggregation', () => {
  // s1: full path, CTA, with repeated views and a back click
  // s2: skips conditional q2, reaches result, no CTA; events arrive out of order
  // s3: drops at q1 after viewing it 3 times
  // s4: started only (dropped on intro)
  // s5: result_viewed lost, but cta_clicked arrived → implied result
  const rows: EventRow[] = [
    ev('s1', 'session_started'), ev('s1', 'step_viewed', 'intro'), ev('s1', 'step_completed', 'intro'),
    ev('s1', 'step_viewed', 'q1'), ev('s1', 'step_viewed', 'q2'), ev('s1', 'back_clicked', 'q2'), ev('s1', 'step_viewed', 'q1'),
    ev('s1', 'step_viewed', 'q2'), ev('s1', 'step_viewed', 'q3'), ev('s1', 'result_viewed', 'result'), ev('s1', 'cta_clicked', 'result'),

    ev('s2', 'result_viewed', 'result'), ev('s2', 'step_viewed', 'q3'), ev('s2', 'session_started'), ev('s2', 'step_viewed', 'q1'), ev('s2', 'step_viewed', 'intro'),

    ev('s3', 'session_started'), ev('s3', 'step_viewed', 'intro'), ev('s3', 'step_viewed', 'q1'), ev('s3', 'step_viewed', 'q1'), ev('s3', 'step_viewed', 'q1'),

    ev('s4', 'session_started'), ev('s4', 'step_viewed', 'intro'),

    ev('s5', 'session_started'), ev('s5', 'step_viewed', 'q3'), ev('s5', 'cta_clicked', 'result'),
  ];

  it('computes core metrics on unique sessions', () => {
    const m = coreMetrics(rows);
    expect(m.started).toBe(5);
    expect(m.reachedResult).toBe(3); // s1, s2, s5 (implied)
    expect(m.ctaClicked).toBe(2);
    expect(m.completionRate).toBeCloseTo(3 / 5);
    expect(m.ctr).toBeCloseTo(2 / 3);
    expect(m.startToCta).toBeCloseTo(2 / 5);
  });

  it('computes per-step reach, conversion and drop-off robustly', () => {
    const steps = Object.fromEntries(stepFunnel(rows, seq).map((s) => [s.stepId, s]));
    expect(steps.intro.reached).toBe(5); // s5 never sent an intro view, but a started session has reached step 0
    expect(steps.q1.reached).toBe(3);
    expect(steps.q1.views).toBe(6); // raw views, but 3 unique sessions
    expect(steps.q1.droppedHere).toBe(1); // s3
    expect(steps.q1.stepConversion).toBeCloseTo(2 / 3);
    expect(steps.q2.reached).toBe(1); // only s1 saw the conditional step
    expect(steps.q2.backClicks).toBe(1);
    expect(steps.q2.droppedHere).toBe(0);
    expect(steps.intro.droppedHere).toBe(1); // s4
    expect(steps.q3.reached).toBe(3);
    expect(steps.result.reached).toBe(3);
    const totalDropped = Object.values(steps).reduce((a, s) => a + s.droppedHere, 0);
    expect(totalDropped + steps.result.reached).toBe(5); // every started session is either dropped somewhere or finished
  });

  it('a session with only session_started counts as dropped on the first step', () => {
    const steps = stepFunnel([...rows, ev('s6', 'session_started')], seq);
    expect(steps[0].reached).toBe(6);
    expect(steps[0].droppedHere).toBe(2); // s4 + s6
    expect(steps.reduce((a, s) => a + s.droppedHere, 0) + steps[steps.length - 1].reached).toBe(6);
  });

  it('is invariant to event order and duplicate deliveries', () => {
    const shuffled = [...rows].reverse();
    const doubled = [...rows, ...rows];
    expect(stepFunnel(shuffled, seq)).toEqual(stepFunnel(rows, seq).map((s) => ({ ...s })));
    const a = stepFunnel(doubled, seq);
    const b = stepFunnel(rows, seq);
    expect(a.map(({ views, ...r }) => r)).toEqual(b.map(({ views, ...r }) => r));
  });

  it('z-test reports significance for large differences only', () => {
    expect(twoProportionTest(100, 1000, 160, 1000).p).toBeLessThan(0.01);
    expect(twoProportionTest(10, 100, 11, 100).p).toBeGreaterThan(0.5);
  });

  it('end-to-end: report through the API ignores duplicate retries and splits by variant and campaign', async () => {
    const { api } = setup();
    const mk = async (variant: string, campaign: string) => (await api.post('/api/sessions').send({ variant, utm: { utm_campaign: campaign } })).body.session;
    const a = await mk('A', 'x');
    const b = await mk('B', 'y');
    const t = new Date().toISOString();
    const batch = {
      events: [
        { event_id: eid(), session_id: a.id, name: 'step_viewed', step_id: 'intro', client_timestamp: t },
        { event_id: eid(), session_id: a.id, name: 'result_viewed', step_id: 'result', client_timestamp: t },
        { event_id: eid(), session_id: a.id, name: 'cta_clicked', step_id: 'result', client_timestamp: t },
        { event_id: eid(), session_id: b.id, name: 'step_viewed', step_id: 'intro', client_timestamp: t },
      ],
    };
    await api.post('/api/events').send(batch);
    await api.post('/api/events').send(batch);
    const report = (await api.get('/api/admin/analytics')).body;
    expect(report.totals).toMatchObject({ started: 2, reachedResult: 1, ctaClicked: 1 });
    const [va, vb] = report.experiment.variants;
    expect(va.metrics).toMatchObject({ started: 1, ctaClicked: 1 });
    expect(vb.metrics).toMatchObject({ started: 1, ctaClicked: 0 });
    const onlyY = (await api.get('/api/admin/analytics?campaign=y')).body;
    expect(onlyY.totals).toMatchObject({ started: 1, ctaClicked: 0 });
    expect(onlyY.campaigns).toEqual(['x', 'y']);
  });
});
