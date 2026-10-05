import type { ClientEvent, IngestResult, SessionDto } from '../../shared/types';
import { http, safe } from './api';

/**
 * Client event pipeline.
 *  - Every event gets its event_id at creation time and is persisted to
 *    localStorage before any network call, so a refresh/close doesn't lose it.
 *  - Events are flushed in batches. A batch is removed from the queue only when
 *    the server answered for each event (accepted / duplicate / rejected).
 *  - On timeout or network error the *same* batch (same event_ids) is retried
 *    with backoff; server-side idempotency makes that safe.
 */
const QUEUE_KEY = 'funnel:eventQueue';
const BATCH = 50;
const FLUSH_MS = 1500;

let queue: ClientEvent[] = safe(() => JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]')) ?? [];
let session: SessionDto | null = null;
let allowed = new Set<string>();
let inflight = false;
let backoff = FLUSH_MS;
let timer: ReturnType<typeof setTimeout> | null = null;

const persist = () => safe(() => localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-1000))));

export function bindSession(s: SessionDto, allowedEvents: string[]) {
  session = s;
  allowed = new Set(allowedEvents);
  schedule(0);
}

export const supportsEvent = (name: string) => allowed.has(name);

/** crypto.randomUUID exists only in secure contexts (https/localhost); getRandomValues works everywhere. */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function track(name: string, stepId: string | null, properties: Record<string, unknown> = {}) {
  if (!session || !allowed.has(name)) return; // events not declared for this version are never sent
  queue.push({
    event_id: uuid(),
    session_id: session.id,
    name,
    client_timestamp: new Date().toISOString(),
    funnel_id: session.funnelId,
    funnel_version: session.version,
    experiment_id: session.experimentId,
    variant: session.variant,
    step_id: stepId,
    ...session.utm,
    properties,
  });
  persist();
  schedule(FLUSH_MS);
}

function schedule(ms: number) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, ms);
}

export async function flush() {
  if (inflight || !queue.length) return;
  inflight = true;
  const batch = queue.slice(0, BATCH);
  try {
    const res = await http<IngestResult>('POST', '/api/events', { events: batch }, { timeoutMs: 5000 });
    const done = new Set([...res.accepted, ...res.duplicates, ...res.rejected.map((r) => r.event_id)]);
    // rejected events can't be fixed by retrying; drop them (they are visible in server logs/response)
    batch.forEach((e, i) => res.rejected.some((r) => r.index === i) && done.add(e.event_id));
    queue = queue.filter((e) => !done.has(e.event_id));
    persist();
    backoff = FLUSH_MS;
  } catch {
    backoff = Math.min(backoff * 2, 30_000); // timeout / offline: keep the batch, retry later with same ids
  } finally {
    inflight = false;
    if (queue.length) schedule(backoff);
  }
}

/** Last-chance delivery when the tab is hidden/closed. Duplicates are harmless. */
function beacon() {
  if (!queue.length || !navigator.sendBeacon) return;
  navigator.sendBeacon('/api/events', new Blob([JSON.stringify({ events: queue.slice(0, BATCH) })], { type: 'text/plain' }));
}
addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && beacon());
addEventListener('pagehide', beacon);
