import type { Db } from './db.js';
import { tx } from './db.js';
import type { SessionStore } from './sessions.js';
import type { IngestResult, SessionDto } from '../shared/types.js';
import { HttpError } from './versions.js';

export const MAX_BATCH = 500;
const EVENT_ID = /^[A-Za-z0-9:_.-]{8,128}$/;
/** Events that must be tied to a concrete step. */
const STEP_REQUIRED = new Set(['step_viewed', 'answer_submitted', 'step_completed', 'back_clicked']);
/** Emitted by the server only; a client can't fake a session start. */
const SERVER_ONLY = new Set(['session_started']);
/** Allowed clock skew for client timestamps. Older/newer values are kept but flagged. */
const MAX_SKEW_MS = 7 * 24 * 3600_000;

type Reject = { index: number; event_id: string | null; reason: string };

export class EventStore {
  constructor(
    private db: Db,
    private sessions: SessionStore,
  ) {}

  /**
   * Idempotent batch ingestion.
   * - event_id is the primary key → INSERT OR IGNORE makes retries/duplicates harmless.
   * - every event is validated on its own; a bad event is reported in `rejected`
   *   and never fails the rest of the batch.
   * - funnel version / variant / experiment / UTM are stamped from the server-side
   *   session (the source of truth), so analytics can't be polluted by a stale client.
   * - properties are whitelisted per event definition of the session's pinned config,
   *   so raw answers can't leak into analytics even if a client sends them.
   */
  ingest(body: unknown, now = new Date()): IngestResult {
    const list = Array.isArray(body) ? body : (body as { events?: unknown })?.events;
    if (!Array.isArray(list)) throw new HttpError(400, 'Expected {"events": [...]}');
    if (list.length > MAX_BATCH) throw new HttpError(413, `Batch too large (max ${MAX_BATCH})`);

    const out: IngestResult = { accepted: [], duplicates: [], rejected: [] };
    const sessionCache = new Map<string, SessionDto | null>();
    const serverTs = now.toISOString();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO events (event_id, session_id, name, funnel_id, funnel_version, experiment_id, variant,
         step_id, utm_source, utm_medium, utm_campaign, client_timestamp, server_timestamp, properties)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    tx(this.db, () => {
      list.forEach((raw, index) => {
        const reject = (reason: string, id: string | null = null) => out.rejected.push({ index, event_id: id, reason });
        try {
          if (!raw || typeof raw !== 'object') return reject('not_an_object');
          const e = raw as Record<string, unknown>;
          const id = typeof e.event_id === 'string' ? e.event_id : null;
          if (!id || !EVENT_ID.test(id)) return reject('invalid_event_id', id);
          if (typeof e.session_id !== 'string') return reject('missing_session_id', id);
          if (typeof e.name !== 'string') return reject('missing_name', id);
          if (SERVER_ONLY.has(e.name)) return reject('server_only_event', id);

          if (!sessionCache.has(e.session_id)) sessionCache.set(e.session_id, this.sessions.get(e.session_id));
          const s = sessionCache.get(e.session_id);
          if (!s) return reject('unknown_session', id);

          const funnel = this.sessions.funnelFor(s);
          const def = funnel.events.allowed.find((d) => d.name === e.name);
          if (!def) return reject(`event_not_allowed_in_v${s.version}`, id);

          if (e.funnel_version !== undefined && e.funnel_version !== s.version) return reject('version_mismatch', id);
          if (e.variant !== undefined && e.variant !== s.variant) return reject('variant_mismatch', id);

          const ts = typeof e.client_timestamp === 'string' || typeof e.client_timestamp === 'number' ? new Date(e.client_timestamp) : null;
          if (!ts || Number.isNaN(ts.getTime())) return reject('invalid_client_timestamp', id);

          const stepId = typeof e.step_id === 'string' ? e.step_id : null;
          if (stepId && !funnel.steps.some((st) => st.id === stepId)) return reject('unknown_step_id', id);
          if (STEP_REQUIRED.has(e.name) && !stepId) return reject('missing_step_id', id);

          const props: Record<string, unknown> = {};
          const inProps = (e.properties && typeof e.properties === 'object' ? e.properties : {}) as Record<string, unknown>;
          for (const key of def.properties) {
            const v = inProps[key];
            if (v === undefined) continue;
            if (v === null || typeof v === 'number' || typeof v === 'boolean') props[key] = v;
            else if (typeof v === 'string') props[key] = v.slice(0, 200);
          }
          if (Math.abs(ts.getTime() - now.getTime()) > MAX_SKEW_MS) props._clock_skew = true;

          const r = insert.run(id, s.id, e.name, s.funnelId, s.version, s.experimentId, s.variant, stepId,
            s.utm.utm_source, s.utm.utm_medium, s.utm.utm_campaign, ts.toISOString(), serverTs, JSON.stringify(props));
          (Number(r.changes) > 0 ? out.accepted : out.duplicates).push(id);
        } catch (err) {
          reject(`internal_error`, typeof (raw as { event_id?: unknown })?.event_id === 'string' ? (raw as { event_id: string }).event_id : null);
          console.error('event ingest failure', err);
        }
      });
    });
    return out;
  }
}
