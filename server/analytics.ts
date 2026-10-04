import type { Db } from './db.js';
import type { VersionStore } from './versions.js';
import { resolveFunnel } from '../shared/engine.js';

/**
 * Aggregation rules (see README → "Analytics rules"):
 *
 * 1. Everything is counted in UNIQUE SESSIONS, never in raw events. Duplicated
 *    event_ids are already dropped at ingest; repeated step_viewed (refresh,
 *    back-and-forth) collapse into one session in a Set.
 * 2. Order-independent: we never use timestamps to decide funnel position. A
 *    session's progress is the furthest step (by index in its variant's
 *    sequence) for which we have *any* evidence, so late/out-of-order events
 *    simply fill the same sets.
 * 3. Implied reach: evidence of a later stage implies the earlier stage
 *    (answer_submitted/step_completed ⇒ step reached; any later step ⇒ this step
 *    completed; cta_clicked ⇒ result reached). Lost or late events don't create
 *    impossible >100% conversions.
 * 4. Drop-off at step S = sessions whose furthest reached step is S and that
 *    never reached the result. Back-clicks don't change the furthest step.
 */

export interface EventRow {
  session_id: string;
  name: string;
  funnel_version: number;
  variant: string;
  step_id: string | null;
  utm_campaign: string | null;
  variant_source?: string | null;
}

export interface Filters {
  funnelId: string;
  version?: number | null;
  campaign?: string | null; // '(none)' selects sessions without a campaign
  excludeOverrides?: boolean;
}

export interface CoreMetrics {
  started: number;
  reachedResult: number;
  ctaClicked: number;
  completionRate: number; // reachedResult / started
  ctr: number; // ctaClicked / reachedResult
  startToCta: number; // ctaClicked / started  ← primary A/B metric
}

export interface StepMetrics {
  stepId: string;
  type: string;
  conditional: boolean;
  reached: number;
  completed: number;
  droppedHere: number;
  backClicks: number; // unique sessions that pressed back on this step
  views: number; // raw step_viewed events (to show repeats vs unique)
  reachedPctOfStarted: number;
  stepConversion: number; // completed / reached  ("→ next step")
  dropOffRate: number; // droppedHere / reached
}

const rate = (a: number, b: number) => (b > 0 ? a / b : 0);

function core(sessions: Set<string>, result: Set<string>, cta: Set<string>): CoreMetrics {
  const started = sessions.size;
  const reachedResult = [...result].filter((s) => sessions.has(s)).length;
  const ctaClicked = [...cta].filter((s) => sessions.has(s)).length;
  return {
    started,
    reachedResult,
    ctaClicked,
    completionRate: rate(reachedResult, started),
    ctr: rate(ctaClicked, reachedResult),
    startToCta: rate(ctaClicked, started),
  };
}

/** Group events by session; return per-session evidence. */
function indexSessions(rows: EventRow[]) {
  const bySession = new Map<string, { version: number; variant: string; rows: EventRow[] }>();
  for (const r of rows) {
    let s = bySession.get(r.session_id);
    if (!s) bySession.set(r.session_id, (s = { version: r.funnel_version, variant: r.variant, rows: [] }));
    s.rows.push(r);
  }
  return bySession;
}

function resultEvidence(rows: EventRow[]) {
  const result = new Set<string>();
  const cta = new Set<string>();
  for (const r of rows) {
    if (r.name === 'result_viewed' || r.name === 'cta_clicked') result.add(r.session_id);
    if (r.name === 'cta_clicked') cta.add(r.session_id);
  }
  return { result, cta };
}

export function coreMetrics(rows: EventRow[]): CoreMetrics {
  const { result, cta } = resultEvidence(rows);
  return core(new Set(rows.map((r) => r.session_id)), result, cta);
}

/** Step funnel for ONE version+variant (sequence = that variant's stepSequence). */
export function stepFunnel(rows: EventRow[], sequence: { id: string; type: string; conditional: boolean }[]): StepMetrics[] {
  const pos = new Map(sequence.map((s, i) => [s.id, i]));
  const resultIdx = sequence.findIndex((s) => s.type === 'result');
  const sessions = new Set<string>();
  const furthest = new Map<string, number>();
  const reached = sequence.map(() => new Set<string>());
  const explicitCompleted = sequence.map(() => new Set<string>());
  const back = sequence.map(() => new Set<string>());
  const views = sequence.map(() => 0);

  const bump = (sid: string, idx: number) => {
    reached[idx].add(sid);
    if ((furthest.get(sid) ?? -1) < idx) furthest.set(sid, idx);
  };

  for (const r of rows) {
    sessions.add(r.session_id);
    const idx = r.step_id ? pos.get(r.step_id) : undefined;
    if (r.name === 'result_viewed' || r.name === 'cta_clicked') {
      if (resultIdx >= 0) bump(r.session_id, resultIdx);
      continue;
    }
    if (idx === undefined) continue;
    switch (r.name) {
      case 'step_viewed':
        views[idx]++;
        bump(r.session_id, idx);
        break;
      case 'answer_submitted':
        bump(r.session_id, idx);
        break;
      case 'step_completed':
        bump(r.session_id, idx);
        explicitCompleted[idx].add(r.session_id);
        break;
      case 'back_clicked':
        back[idx].add(r.session_id);
        bump(r.session_id, idx);
        break;
    }
  }
  const started = sessions.size;
  const reachedResult = resultIdx >= 0 ? reached[resultIdx] : new Set<string>();

  return sequence.map((step, i) => {
    // completed = explicit step_completed OR evidence of any later step
    const completed = new Set(explicitCompleted[i]);
    for (const sid of reached[i]) if ((furthest.get(sid) ?? -1) > i) completed.add(sid);
    if (step.type === 'result') for (const sid of reached[i]) completed.add(sid);
    let dropped = 0;
    if (step.type !== 'result') for (const sid of reached[i]) if (furthest.get(sid) === i && !reachedResult.has(sid)) dropped++;
    return {
      stepId: step.id,
      type: step.type,
      conditional: step.conditional,
      reached: reached[i].size,
      completed: completed.size,
      droppedHere: dropped,
      backClicks: back[i].size,
      views: views[i],
      reachedPctOfStarted: rate(reached[i].size, started),
      stepConversion: rate(completed.size, reached[i].size),
      dropOffRate: rate(dropped, reached[i].size),
    };
  });
}

/** Two-proportion z-test (pooled). Returns two-sided p-value. */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number) {
  if (!n1 || !n2) return { z: 0, p: 1 };
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p: 1 };
  const z = (x2 / n2 - x1 / n1) / se;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

function normalCdf(x: number) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * (x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + y);
}

// ------------------------------------------------------------------ report

export function buildReport(db: Db, versions: VersionStore, f: Filters) {
  const where: string[] = ['e.funnel_id = ?'];
  const params: (string | number)[] = [f.funnelId];
  if (f.campaign === '(none)') where.push('e.utm_campaign IS NULL');
  else if (f.campaign) {
    where.push('e.utm_campaign = ?');
    params.push(f.campaign);
  }
  if (f.excludeOverrides) where.push(`s.variant_source <> 'override'`);
  const rows = db
    .prepare(
      `SELECT e.session_id, e.name, e.funnel_version, e.variant, e.step_id, e.utm_campaign
       FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE ${where.join(' AND ')}`,
    )
    .all(...params) as unknown as EventRow[];

  const campaigns = (
    db.prepare('SELECT DISTINCT utm_campaign AS c FROM sessions WHERE funnel_id = ? ORDER BY c').all(f.funnelId) as { c: string | null }[]
  ).map((r) => r.c ?? '(none)');

  const bySession = indexSessions(rows);
  const groupKey = (v: number, variant: string) => `${v}|${variant}`;
  const groups = new Map<string, EventRow[]>();
  for (const s of bySession.values()) {
    const k = groupKey(s.version, s.variant);
    const g = groups.get(k) ?? [];
    g.push(...s.rows);
    groups.set(k, g);
  }
  const versionList = [...new Set([...bySession.values()].map((s) => s.version))].sort((a, b) => a - b);
  const activeVersion = versions.activeVersion(f.funnelId);
  const selectedVersion = f.version ?? activeVersion ?? versionList[versionList.length - 1] ?? null;

  // Version comparison (all variants together + per variant)
  const versionsTable = versionList.map((v) => {
    const all = rows.filter((r) => r.funnel_version === v);
    const variants = Object.fromEntries(
      [...groups.entries()]
        .filter(([k]) => k.startsWith(`${v}|`))
        .map(([k, g]) => [k.split('|')[1], coreMetrics(g)]),
    );
    return { version: v, active: v === activeVersion, total: coreMetrics(all), variants };
  });

  // Selected version: A/B comparison + per-variant step funnels
  let experiment = null;
  if (selectedVersion !== null) {
    let cfg;
    try {
      cfg = versions.get(f.funnelId, selectedVersion);
    } catch {
      cfg = null;
    }
    if (cfg) {
      const variantNames = Object.keys(cfg.experiment.variants).sort();
      const perVariant = variantNames.map((name) => {
        const g = groups.get(groupKey(selectedVersion, name)) ?? [];
        const resolved = resolveFunnel(cfg, name);
        const sequence = resolved.steps.map((s) => ({ id: s.id, type: s.type, conditional: Boolean(s.visibleWhen) }));
        const counts = new Map<string, { events: number; sessions: Set<string> }>();
        for (const r of g) {
          const c = counts.get(r.name) ?? { events: 0, sessions: new Set() };
          c.events++;
          c.sessions.add(r.session_id);
          counts.set(r.name, c);
        }
        return {
          variant: name,
          metrics: coreMetrics(g),
          steps: stepFunnel(g, sequence),
          events: Object.fromEntries([...counts].map(([n, c]) => [n, { events: c.events, sessions: c.sessions.size }])),
        };
      });
      const [a, b] = perVariant;
      const tests =
        a && b
          ? {
              startToCta: twoProportionTest(a.metrics.ctaClicked, a.metrics.started, b.metrics.ctaClicked, b.metrics.started),
              completionRate: twoProportionTest(a.metrics.reachedResult, a.metrics.started, b.metrics.reachedResult, b.metrics.started),
              ctr: twoProportionTest(a.metrics.ctaClicked, a.metrics.reachedResult, b.metrics.ctaClicked, b.metrics.reachedResult),
            }
          : null;
      experiment = { version: selectedVersion, experimentId: cfg.experiment.id, variants: perVariant, tests };
    }
  }

  return {
    filters: { ...f, version: selectedVersion },
    activeVersion,
    campaigns,
    totals: coreMetrics(rows),
    rawEventCount: rows.length,
    versions: versionsTable,
    experiment,
  };
}
