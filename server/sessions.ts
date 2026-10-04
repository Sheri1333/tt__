import crypto from 'node:crypto';
import type { Db } from './db.js';
import { tx } from './db.js';
import { HttpError, VersionStore } from './versions.js';
import type { ResolvedFunnel, SessionDto, SessionState, Utm } from '../shared/types.js';
import { answerKey, computeResultId, isComplete, pickVariant, resolveFunnel, validateAnswer } from '../shared/engine.js';

interface SessionRow {
  id: string;
  funnel_id: string;
  version: number;
  experiment_id: string;
  variant: string;
  variant_source: 'hash' | 'override';
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  state: string;
  created_at: string;
  expires_at: string;
}

const toDto = (r: SessionRow): SessionDto => ({
  id: r.id,
  funnelId: r.funnel_id,
  version: r.version,
  experimentId: r.experiment_id,
  variant: r.variant,
  variantSource: r.variant_source,
  utm: { utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign },
  state: JSON.parse(r.state),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

export interface ResumeInput {
  funnelId: string;
  sessionId?: string | null;
  utm?: Partial<Utm>;
  variantOverride?: string | null;
  now?: Date;
}

const clean = (v: unknown, max = 100): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

export class SessionStore {
  private resolvedCache = new Map<string, ResolvedFunnel>();
  constructor(
    private db: Db,
    private versions: VersionStore,
  ) {}

  funnelFor(s: Pick<SessionDto, 'funnelId' | 'version' | 'variant'>): ResolvedFunnel {
    const key = `${s.funnelId}@${s.version}/${s.variant}`;
    let f = this.resolvedCache.get(key);
    if (!f) {
      f = resolveFunnel(this.versions.get(s.funnelId, s.version), s.variant);
      this.resolvedCache.set(key, f);
    }
    return f;
  }

  get(id: string): SessionDto | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? toDto(row) : null;
  }

  /**
   * Continue an existing session on its pinned version/variant, or start a new
   * one on the *currently active* version. Returns `created` so the caller knows.
   */
  resume(input: ResumeInput): { session: SessionDto; created: boolean } {
    const now = input.now ?? new Date();
    const override = clean(input.variantOverride, 10);
    if (input.sessionId) {
      const existing = this.get(input.sessionId);
      const usable =
        existing &&
        existing.funnelId === input.funnelId &&
        new Date(existing.expiresAt) > now &&
        // A QA override for a *different* variant must not mutate a running session:
        // the variant is sticky, so we start a fresh session instead.
        (!override || override === existing.variant);
      if (usable) return { session: existing, created: false };
    }
    return { session: this.create(input, now), created: true };
  }

  private create(input: ResumeInput, now: Date): SessionDto {
    const config = this.versions.active(input.funnelId);
    const id = crypto.randomUUID();
    const override = clean(input.variantOverride, 10);
    if (override && !config.experiment.variants[override])
      throw new HttpError(400, `Unknown variant override "${override}"`);
    const variant = override ?? pickVariant(config, id);
    const firstStep = resolveFunnel(config, variant).steps[0].id;
    const state: SessionState = { answers: {}, path: [firstStep], resultId: null };
    const iso = now.toISOString();
    const expires = new Date(now.getTime() + config.session.ttlHours * 3600_000).toISOString();
    const utm = {
      utm_source: clean(input.utm?.utm_source),
      utm_medium: clean(input.utm?.utm_medium),
      utm_campaign: clean(input.utm?.utm_campaign),
    };
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, funnel_id, version, experiment_id, variant, variant_source,
             utm_source, utm_medium, utm_campaign, state, created_at, updated_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, config.funnelId, config.version, config.experiment.id, variant, override ? 'override' : 'hash',
          utm.utm_source, utm.utm_medium, utm.utm_campaign, JSON.stringify(state), iso, iso, expires);
      // session_started is emitted by the server, inside the same transaction:
      // a session can never exist without its start event.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO events (event_id, session_id, name, funnel_id, funnel_version, experiment_id, variant,
             step_id, utm_source, utm_medium, utm_campaign, client_timestamp, server_timestamp, properties)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(`srv:${id}:session_started`, id, 'session_started', config.funnelId, config.version, config.experiment.id,
          variant, null, utm.utm_source, utm.utm_medium, utm.utm_campaign, iso, iso,
          JSON.stringify({ variant_source: override ? 'override' : 'hash' }));
    });
    return this.get(id)!;
  }

  /** Persist answers + navigation path. Every answer is re-validated against the pinned config. */
  saveState(id: string, incoming: unknown): SessionDto {
    const session = this.get(id);
    if (!session) throw new HttpError(404, 'Session not found');
    if (new Date(session.expiresAt) <= new Date()) throw new HttpError(410, 'Session expired');
    const funnel = this.funnelFor(session);
    const body = incoming as Partial<SessionState>;
    const answers = body?.answers && typeof body.answers === 'object' ? body.answers : {};
    const path = Array.isArray(body?.path) ? body.path : [];

    const byKey = new Map(funnel.steps.map((s) => [answerKey(s), s]));
    const stepIds = new Set(funnel.steps.map((s) => s.id));
    const errors: string[] = [];
    for (const [key, value] of Object.entries(answers)) {
      const step = byKey.get(key);
      if (!step) errors.push(`answers.${key}: not a question of v${session.version}/${session.variant}`);
      else {
        const err = validateAnswer(step, value);
        if (err) errors.push(`answers.${key}: ${err.message}`);
      }
    }
    if (!path.length || path.some((p) => typeof p !== 'string' || !stepIds.has(p))) errors.push('path: unknown step id');
    if (errors.length) throw new HttpError(422, 'Invalid state', errors);

    const next: SessionState = {
      answers,
      path: path.slice(-100),
      resultId: session.state.resultId ?? null,
      ctaClicked: Boolean(body.ctaClicked ?? session.state.ctaClicked),
    };
    const ttl = this.versions.get(session.funnelId, session.version).session.ttlHours;
    const now = new Date();
    this.db
      .prepare('UPDATE sessions SET state = ?, updated_at = ?, expires_at = ? WHERE id = ?')
      .run(JSON.stringify(next), now.toISOString(), new Date(now.getTime() + ttl * 3600_000).toISOString(), id);
    return this.get(id)!;
  }

  /** The result is computed server-side from stored answers and the pinned config. */
  result(id: string) {
    const session = this.get(id);
    if (!session) throw new HttpError(404, 'Session not found');
    const funnel = this.funnelFor(session);
    if (!isComplete(funnel, session.state.answers)) throw new HttpError(409, 'Not all visible questions are answered');
    const resultId = computeResultId(funnel, session.state.answers);
    const state = { ...session.state, resultId };
    this.db.prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(state), new Date().toISOString(), id);
    return { resultId, result: funnel.results[resultId] };
  }
}
