/**
 * Synthetic traffic generator. Talks to a running server over HTTP (local or public URL).
 *
 *   npm run generate                         # 150 sessions on the active version
 *   npm run generate -- --sessions 300 --url https://your-host --token $ADMIN_TOKEN
 *   npm run scenario                         # full release story: v1 → v2 → v3 → rollback, with pinned in-flight sessions
 *
 * It simulates: several UTM campaigns, server-assigned A/B, different branches,
 * drop-off at different steps, back clicks, repeated views (refresh), duplicate
 * events in a batch, the same batch re-sent (timeout retry), batches delivered in
 * reverse order, and a few invalid events. It keeps its own ground truth and, at
 * the end, verifies the dashboard's numbers moved by exactly that amount.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AnswerValue, Answers, ClientEvent, IngestResult, ResolvedFunnel, SessionDto, StepConfig } from '../shared/types.js';
import { answerKey, answerKind, computeResultId, isInteractive, nextStepId, progressOf } from '../shared/engine.js';

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const BASE = opt('url', process.env.FUNNEL_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = opt('token', process.env.ADMIN_TOKEN ?? '');
const N = Number(opt('sessions', '150'));
const SCENARIO = args.includes('--scenario');
let seed = Number(opt('seed', String(Date.now() % 100000)));

// deterministic PRNG (mulberry32) for user behaviour; variants still depend on server-generated session ids
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const chance = (p: number) => rand() < p;
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

// ------------------------------------------------------------------ http
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

// ------------------------------------------------------------------ traffic model
const CAMPAIGNS = [
  { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'q4_search', w: 35 },
  { utm_source: 'linkedin', utm_medium: 'paid_social', utm_campaign: 'team_health', w: 25 },
  { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'oct_digest', w: 20 },
  { utm_source: 'partner_blog', utm_medium: 'referral', utm_campaign: 'partner_launch', w: 10 },
  { utm_source: null, utm_medium: null, utm_campaign: null, w: 10 }, // direct
];
const pickCampaign = () => {
  let r = rand() * 100;
  for (const c of CAMPAIGNS) if ((r -= c.w) < 0) return c;
  return CAMPAIGNS[0];
};

/** Hypothesis baked into the simulation: B's framing reduces early drop and lifts CTA. */
const BEHAVIOUR = {
  A: { introDrop: 0.12, stepDrop: 0.05, cta: 0.42 },
  B: { introDrop: 0.08, stepDrop: 0.045, cta: 0.55 },
} as Record<string, { introDrop: number; stepDrop: number; cta: number }>;
const CAMPAIGN_FACTOR: Record<string, number> = { q4_search: 1, team_health: 0.8, oct_digest: 0.6, partner_launch: 1.3, direct: 1 };

function randomAnswer(step: StepConfig): AnswerValue {
  const opts = step.input?.options ?? [];
  if (step.type === 'single-select') return pick(opts).value;
  if (step.type === 'multi-select') {
    const max = Math.min(step.validation?.maxSelections ?? 3, opts.length);
    const shuffled = [...opts].sort(() => rand() - 0.5);
    return shuffled.slice(0, int(1, max)).map((o) => o.value);
  }
  const min = step.input?.min ?? 0;
  const max = step.input?.max ?? 100;
  const ranges: Record<string, [number, number]> = { team_size: [3, 60], meeting_hours: [2, 25], tool_count: [3, 15] };
  const [a, b] = ranges[step.id] ?? [min, max];
  return Math.min(max, Math.max(min, int(a, b)));
}

// ------------------------------------------------------------------ simulated user
type Truth = { started: number; reachedResult: number; ctaClicked: number; dropped: Record<string, number>; results: Record<string, number> };
const truth = new Map<string, Truth>(); // key: v|variant
const t = (s: SessionDto) => {
  const k = `${s.version}|${s.variant}`;
  if (!truth.has(k)) truth.set(k, { started: 0, reachedResult: 0, ctaClicked: 0, dropped: {}, results: {} });
  return truth.get(k)!;
};
const delivery = { batches: 0, retriedBatches: 0, reversedSessions: 0, inBatchDuplicates: 0, invalidSent: 0, accepted: 0, duplicates: 0, rejected: 0 };

class SimUser {
  answers: Answers = {};
  path: string[] = [];
  events: ClientEvent[] = [];
  clock: number;
  finished = false;
  constructor(
    public session: SessionDto,
    public funnel: ResolvedFunnel,
  ) {
    this.clock = Date.now() - int(0, 3 * 24 * 3600) * 1000;
    this.path = [...session.state.path];
    this.answers = { ...session.state.answers };
  }
  get step() {
    return this.funnel.steps.find((s) => s.id === this.path[this.path.length - 1])!;
  }
  emit(name: string, stepId: string | null, properties: Record<string, unknown> = {}) {
    if (!this.funnel.events.allowed.some((e) => e.name === name)) return;
    this.clock += int(2, 25) * 1000;
    this.events.push({
      event_id: crypto.randomUUID(),
      session_id: this.session.id,
      name,
      client_timestamp: new Date(this.clock).toISOString(),
      funnel_id: this.session.funnelId,
      funnel_version: this.session.version,
      experiment_id: this.session.experimentId,
      variant: this.session.variant,
      step_id: stepId,
      ...this.session.utm,
      properties,
    });
  }
  view() {
    const p = progressOf(this.funnel, this.step.id, this.answers);
    this.emit('step_viewed', this.step.id, { step_type: this.step.type, visible_step_index: p.index, visible_step_count: p.total });
  }

  /** Walk until the result, a drop-off, or `stopAfter` steps (to leave the session in flight). */
  walk(stopAfter = Infinity) {
    const b = BEHAVIOUR[this.session.variant] ?? BEHAVIOUR.A;
    const factor = CAMPAIGN_FACTOR[this.session.utm.utm_campaign ?? 'direct'] ?? 1;
    let taken = 0;
    this.view();
    while (this.step.type !== 'result') {
      if (taken++ >= stopAfter) return 'paused';
      const step = this.step;
      const dropP = step.type === 'info' ? b.introDrop : b.stepDrop * (step.type === 'number' ? 1.4 : 1);
      if (chance(dropP / factor)) {
        t(this.session).dropped[step.id] = (t(this.session).dropped[step.id] ?? 0) + 1;
        this.finished = true;
        return 'dropped';
      }
      if (chance(0.05)) this.view(); // refresh → repeated step_viewed
      if (isInteractive(step)) {
        const value = randomAnswer(step);
        this.answers[answerKey(step)] = value;
        this.emit('answer_submitted', step.id, { answer_kind: answerKind(step, value), raw_value: value /* must be dropped by the server */ });
      }
      const next = nextStepId(this.funnel, step.id, this.answers)!;
      if (isInteractive(step)) this.emit('step_completed', step.id, { next_step_id: next });
      this.path.push(next);
      this.view();
      // occasionally go back one step and re-answer (may switch branch, e.g. work_mode)
      if (this.path.length > 2 && chance(0.06)) {
        const from = this.path.pop()!;
        this.emit('back_clicked', from, { destination_step_id: this.path[this.path.length - 1] });
        this.view();
      }
    }
    const resultId = computeResultId(this.funnel, this.answers);
    t(this.session).reachedResult++;
    t(this.session).results[resultId] = (t(this.session).results[resultId] ?? 0) + 1;
    this.emit('result_viewed', 'result', { result_id: resultId });
    const ctaP = Math.min(0.95, b.cta * factor);
    if (chance(ctaP)) {
      const action = this.funnel.results[resultId].cta.action;
      this.emit('cta_clicked', 'result', { result_id: resultId, action });
      this.emit('recommendation_expanded', 'result', { result_id: resultId, action, source: 'cta' });
      t(this.session).ctaClicked++;
    }
    this.finished = true;
    return 'finished';
  }

  async saveState() {
    await call('PUT', `/api/sessions/${this.session.id}/state`, { answers: this.answers, path: this.path });
  }

  /** Deliver collected events with realistic network chaos. */
  async flush() {
    const evs = this.events.splice(0);
    if (!evs.length) return;
    const batches: ClientEvent[][] = [];
    for (let i = 0; i < evs.length; ) {
      const size = int(2, 7);
      batches.push(evs.slice(i, i + size));
      i += size;
    }
    if (chance(0.12)) {
      batches.reverse(); // late batches arrive first
      delivery.reversedSessions++;
    }
    for (const batch of batches) {
      const payload = [...batch];
      if (chance(0.06)) {
        payload.push({ ...pick(batch) }); // same event twice inside one batch
        delivery.inBatchDuplicates++;
      }
      if (chance(0.03)) {
        payload.push({ ...batch[0], event_id: crypto.randomUUID(), step_id: 'no_such_step' });
        delivery.invalidSent++;
      }
      await send(payload);
      if (chance(0.1)) {
        await send(payload); // client timed out and retried the identical batch
        delivery.retriedBatches++;
      }
    }
  }
}

async function send(events: ClientEvent[]) {
  const r = await call<IngestResult>('POST', '/api/events', { events });
  delivery.batches++;
  delivery.accepted += r.accepted.length;
  delivery.duplicates += r.duplicates.length;
  delivery.rejected += r.rejected.length;
}

async function startSession() {
  const c = pickCampaign();
  const env = await call<{ session: SessionDto; funnel: ResolvedFunnel }>('POST', '/api/sessions', {
    utm: { utm_source: c.utm_source, utm_medium: c.utm_medium, utm_campaign: c.utm_campaign },
  });
  t(env.session).started++;
  return new SimUser(env.session, env.funnel);
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

async function runBatch(n: number, inFlight = 0): Promise<SimUser[]> {
  const paused: SimUser[] = [];
  await pool(Array.from({ length: n }, (_, i) => i), 8, async (i) => {
    const u = await startSession();
    const status = u.walk(i < inFlight ? int(1, 3) : Infinity);
    if (status === 'paused') {
      await u.saveState();
      paused.push(u);
    }
    await u.flush();
  });
  return paused;
}

async function resume(users: SimUser[]) {
  for (const u of users) {
    const env = await call<{ created: boolean; session: SessionDto; funnel: ResolvedFunnel }>('POST', '/api/sessions', { sessionId: u.session.id });
    if (env.created || env.session.version !== u.session.version)
      throw new Error(`Session ${u.session.id} lost its pinned version (v${u.session.version} → v${env.session.version})`);
    if (env.session.state.path.join() !== u.path.join()) throw new Error(`Session ${u.session.id} state was not persisted`);
    u.walk();
    await u.flush();
  }
}

// ------------------------------------------------------------------ admin helpers
const FUNNEL = 'workstyle-planner';
const activeVersion = async () => (await call<{ activeVersion: number }>('GET', `/api/admin/funnels/${FUNNEL}`)).activeVersion;
async function publishFile(file: string) {
  const cfg = JSON.parse(fs.readFileSync(path.resolve('configs', file), 'utf8'));
  await call('POST', '/api/admin/versions', cfg); // idempotent if already stored
  await call('POST', `/api/admin/funnels/${FUNNEL}/versions/${cfg.version}/publish`);
  console.log(`  published v${cfg.version} (${file})`);
}

type Core = { started: number; reachedResult: number; ctaClicked: number };
type VersionsTable = { version: number; variants: Record<string, Core> }[];
const snapshot = async () => (await call<{ versions: VersionsTable }>('GET', `/api/admin/analytics?funnelId=${FUNNEL}`)).versions;

// ------------------------------------------------------------------ main
async function main() {
  await call('GET', '/api/health').catch(() => {
    throw new Error(`Server is not reachable at ${BASE}. Start it with "npm run dev" or "npm start".`);
  });
  const before = await snapshot();
  console.log(`Generating against ${BASE} (seed ${seed})`);

  if (!SCENARIO) {
    console.log(`Active version: v${await activeVersion()} — ${N} sessions`);
    await runBatch(N);
  } else {
    const per = Math.max(40, Math.round(N / 3));
    console.log('Scenario: v1 traffic → publish v2 → old v1 sessions finish on v1 → publish v3 → rollback → v3 sessions finish on v3');
    await publishFile('funnel-v1.json');
    const v1InFlight = await runBatch(per, 12);
    await publishFile('funnel-v2.json');
    const v2InFlight = await runBatch(per, 6);
    await resume(v1InFlight);
    console.log(`  ✓ ${v1InFlight.length} in-flight v1 sessions resumed and finished on v1 after v2 was published`);
    await publishFile('funnel-v3.json');
    const v3InFlight = await runBatch(per, 12);
    await call('POST', `/api/admin/funnels/${FUNNEL}/rollback`);
    const after = await activeVersion();
    console.log(`  rolled back → active v${after}`);
    await resume([...v2InFlight, ...v3InFlight]);
    console.log(`  ✓ ${v3InFlight.length} in-flight v3 sessions finished on v3 after rollback (recommendation_expanded accepted)`);
    const probe = await call<{ session: SessionDto }>('POST', '/api/sessions', {});
    if (probe.session.version !== after) throw new Error('New session did not start on the active version');
    console.log(`  ✓ new sessions start on v${after}`);
    t(probe.session).started++; // the probe is a real (empty) session too
  }

  // -------------------------------------------------------------- verify against the dashboard
  const afterSnap = await snapshot();
  const get = (snap: VersionsTable, v: number, variant: string) => snap.find((x) => x.version === v)?.variants[variant] ?? { started: 0, reachedResult: 0, ctaClicked: 0 };
  const rows: Record<string, unknown>[] = [];
  let ok = true;
  for (const [key, tr] of [...truth.entries()].sort()) {
    const [v, variant] = key.split('|');
    const a = get(afterSnap, Number(v), variant);
    const b = get(before, Number(v), variant);
    const d = { started: a.started - b.started, reachedResult: a.reachedResult - b.reachedResult, ctaClicked: a.ctaClicked - b.ctaClicked };
    const match = d.started === tr.started && d.reachedResult === tr.reachedResult && d.ctaClicked === tr.ctaClicked;
    ok &&= match;
    rows.push({
      version: `v${v}`, variant,
      started: `${tr.started} / ${d.started}`,
      result: `${tr.reachedResult} / ${d.reachedResult}`,
      cta: `${tr.ctaClicked} / ${d.ctaClicked}`,
      'start→CTA': `${((100 * tr.ctaClicked) / Math.max(tr.started, 1)).toFixed(1)}%`,
      match: match ? '✓' : '✗',
    });
  }
  console.log('\nGround truth vs dashboard delta (truth / dashboard):');
  console.table(rows);
  console.log('Delivery chaos:', delivery);
  fs.writeFileSync('generator-report.json', JSON.stringify({ base: BASE, seed, truth: Object.fromEntries(truth), delivery }, null, 2));
  console.log('Details (incl. drop-off per step and result distribution) → generator-report.json');
  if (!ok) {
    console.error('✗ Dashboard does not match the simulated ground truth (was other traffic running at the same time?)');
    process.exit(1);
  }
  console.log('✓ Dashboard matches the simulated ground truth');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
