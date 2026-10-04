import type { ResolvedFunnel, SessionDto, SessionState, ResultConfig } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'funnel:adminToken';
export const adminToken = {
  get: () => safe(() => localStorage.getItem(TOKEN_KEY)) ?? '',
  set: (t: string) => safe(() => localStorage.setItem(TOKEN_KEY, t)),
};

export function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export async function http<T>(method: string, url: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-admin-token': adminToken.get() },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.details);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface SessionEnvelope {
  created: boolean;
  session: SessionDto;
  funnel: ResolvedFunnel;
}

export const api = {
  resume: (body: { sessionId?: string | null; utm: Record<string, string | null>; variant?: string | null }) =>
    http<SessionEnvelope>('POST', '/api/sessions', body),
  saveState: (id: string, state: SessionState) => http<{ session: SessionDto }>('PUT', `/api/sessions/${id}/state`, state),
  result: (id: string) => http<{ resultId: string; result: ResultConfig }>('POST', `/api/sessions/${id}/result`, {}),
};
