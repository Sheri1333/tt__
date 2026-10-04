import crypto from 'node:crypto';
import type { Db } from './db.js';
import { tx } from './db.js';
import type { FunnelConfig } from '../shared/types.js';
import { validateConfig } from './configValidation.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

export interface VersionSummary {
  funnelId: string;
  version: number;
  releaseNote: string | null;
  createdAt: string;
  checksum: string;
  active: boolean;
  sessions: number;
}

export class VersionStore {
  private cache = new Map<string, FunnelConfig>();
  constructor(private db: Db) {}

  /** Store a config as an immutable version. Re-uploading identical content is a no-op. */
  add(raw: unknown): { config: FunnelConfig; created: boolean } {
    const res = validateConfig(raw);
    if (!res.ok) throw new HttpError(422, 'Invalid funnel config', res.errors);
    const config = res.config;
    const checksum = crypto.createHash('sha256').update(canonical(raw)).digest('hex');
    const existing = this.db
      .prepare('SELECT checksum FROM funnel_versions WHERE funnel_id = ? AND version = ?')
      .get(config.funnelId, config.version) as { checksum: string } | undefined;
    if (existing) {
      if (existing.checksum === checksum) return { config, created: false };
      throw new HttpError(409, `Version ${config.version} already exists with different content; versions are immutable — bump "version".`);
    }
    this.db
      .prepare('INSERT INTO funnel_versions (funnel_id, version, config, checksum, release_note, created_at) VALUES (?,?,?,?,?,?)')
      .run(config.funnelId, config.version, JSON.stringify(raw), checksum, config.releaseNote ?? null, new Date().toISOString());
    return { config, created: true };
  }

  get(funnelId: string, version: number): FunnelConfig {
    const key = `${funnelId}@${version}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const row = this.db.prepare('SELECT config FROM funnel_versions WHERE funnel_id = ? AND version = ?').get(funnelId, version) as
      | { config: string }
      | undefined;
    if (!row) throw new HttpError(404, `Funnel ${funnelId} v${version} not found`);
    const cfg = JSON.parse(row.config) as FunnelConfig;
    this.cache.set(key, cfg); // versions are immutable, so caching forever is safe
    return cfg;
  }

  activeVersion(funnelId: string): number | null {
    const row = this.db.prepare('SELECT version FROM funnel_active WHERE funnel_id = ?').get(funnelId) as
      | { version: number }
      | undefined;
    return row?.version ?? null;
  }

  active(funnelId: string): FunnelConfig {
    const v = this.activeVersion(funnelId);
    if (v === null) throw new HttpError(404, `Funnel ${funnelId} has no active version`);
    return this.get(funnelId, v);
  }

  /** Make `version` the one new sessions start on. Existing sessions are untouched (they are pinned). */
  activate(funnelId: string, version: number, action: 'publish' | 'activate' | 'rollback' = 'publish') {
    this.get(funnelId, version); // 404 if missing
    return tx(this.db, () => {
      const from = this.activeVersion(funnelId);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO funnel_active (funnel_id, version, updated_at) VALUES (?,?,?)
           ON CONFLICT(funnel_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
        )
        .run(funnelId, version, now);
      this.db
        .prepare('INSERT INTO release_log (funnel_id, action, from_version, to_version, at) VALUES (?,?,?,?,?)')
        .run(funnelId, action, from, version, now);
      return { from, to: version };
    });
  }

  /**
   * Replays the release log as a stack: publish/activate push, rollback pops.
   * So v1 → v2 → v3, rollback → v2, rollback → v1 (not back to v3).
   */
  activationStack(funnelId: string): number[] {
    const rows = this.db
      .prepare('SELECT action, to_version FROM release_log WHERE funnel_id = ? ORDER BY id')
      .all(funnelId) as { action: string; to_version: number }[];
    const stack: number[] = [];
    for (const r of rows) {
      if (r.action === 'rollback') stack.pop();
      else if (stack[stack.length - 1] !== r.to_version) stack.push(r.to_version);
    }
    return stack;
  }

  rollback(funnelId: string) {
    const stack = this.activationStack(funnelId);
    const target = stack[stack.length - 2];
    if (target === undefined) throw new HttpError(409, 'Nothing to roll back to');
    return this.activate(funnelId, target, 'rollback');
  }

  list(funnelId: string): VersionSummary[] {
    const active = this.activeVersion(funnelId);
    const rows = this.db
      .prepare(
        `SELECT v.funnel_id, v.version, v.release_note, v.created_at, v.checksum,
                (SELECT COUNT(*) FROM sessions s WHERE s.funnel_id = v.funnel_id AND s.version = v.version) AS sessions
         FROM funnel_versions v WHERE v.funnel_id = ? ORDER BY v.version DESC`,
      )
      .all(funnelId) as Record<string, unknown>[];
    return rows.map((r) => ({
      funnelId: r.funnel_id as string,
      version: r.version as number,
      releaseNote: (r.release_note as string) ?? null,
      createdAt: r.created_at as string,
      checksum: (r.checksum as string).slice(0, 12),
      active: r.version === active,
      sessions: r.sessions as number,
    }));
  }

  log(funnelId: string) {
    return this.db
      .prepare('SELECT action, from_version AS "from", to_version AS "to", at FROM release_log WHERE funnel_id = ? ORDER BY id DESC LIMIT 50')
      .all(funnelId);
  }

  funnels(): string[] {
    return (this.db.prepare('SELECT DISTINCT funnel_id FROM funnel_versions ORDER BY funnel_id').all() as { funnel_id: string }[]).map(
      (r) => r.funnel_id,
    );
  }
}
