import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

// Forward-only migrations, applied automatically on start. Funnel changes
// (new steps, events, results) never require a schema change: configs are
// stored as JSON and events keep a generic `properties` column.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE funnel_versions (
    funnel_id    TEXT    NOT NULL,
    version      INTEGER NOT NULL,
    config       TEXT    NOT NULL,
    checksum     TEXT    NOT NULL,
    release_note TEXT,
    created_at   TEXT    NOT NULL,
    PRIMARY KEY (funnel_id, version)
  );
  CREATE TABLE funnel_active (
    funnel_id  TEXT PRIMARY KEY,
    version    INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- Append-only audit of activations; rollback walks this log.
  CREATE TABLE release_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    funnel_id    TEXT NOT NULL,
    action       TEXT NOT NULL,            -- publish | rollback | activate
    from_version INTEGER,
    to_version   INTEGER NOT NULL,
    at           TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    funnel_id      TEXT NOT NULL,
    version        INTEGER NOT NULL,
    experiment_id  TEXT NOT NULL,
    variant        TEXT NOT NULL,
    variant_source TEXT NOT NULL,          -- hash | override
    utm_source     TEXT,
    utm_medium     TEXT,
    utm_campaign   TEXT,
    state          TEXT NOT NULL,          -- answers + path; never copied into events
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    expires_at     TEXT NOT NULL
  );
  CREATE TABLE events (
    event_id         TEXT PRIMARY KEY,     -- idempotency key
    session_id       TEXT NOT NULL,
    name             TEXT NOT NULL,
    funnel_id        TEXT NOT NULL,
    funnel_version   INTEGER NOT NULL,
    experiment_id    TEXT NOT NULL,
    variant          TEXT NOT NULL,
    step_id          TEXT,
    utm_source       TEXT,
    utm_medium       TEXT,
    utm_campaign     TEXT,
    client_timestamp TEXT NOT NULL,
    server_timestamp TEXT NOT NULL,
    properties       TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_session ON events(session_id);
  CREATE INDEX events_version_variant ON events(funnel_id, funnel_version, variant);
  CREATE INDEX events_campaign ON events(utm_campaign);
  `,
];

export function openDb(file = process.env.DB_FILE ?? path.resolve('data', 'funnel.db')): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const current = row.v ?? 0;
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (version <= current) return;
    tx(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    });
  });
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
