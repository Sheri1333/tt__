import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { HttpError, VersionStore } from './versions.js';
import { SessionStore } from './sessions.js';
import { EventStore } from './events.js';
import { buildReport } from './analytics.js';

export const DEFAULT_FUNNEL = process.env.DEFAULT_FUNNEL ?? 'workstyle-planner';
export const CONFIG_DIR = path.resolve('configs');

export interface AppOptions {
  db: Db;
  adminToken?: string;
  staticDir?: string;
}

export function createApp({ db, adminToken, staticDir }: AppOptions) {
  const versions = new VersionStore(db);
  const sessions = new SessionStore(db, versions);
  const events = new EventStore(db, sessions);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', type: ['application/json', 'text/plain'] })); // text/plain: sendBeacon

  const funnelOf = (req: Request) => String(req.query.funnelId ?? req.body?.funnelId ?? DEFAULT_FUNNEL);
  const withFunnel = (s: ReturnType<SessionStore['get']>) => ({ session: s, funnel: s ? sessions.funnelFor(s) : null });

  // ---------------------------------------------------------------- public API
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  /** Resume the stored session (pinned version + variant) or start a new one on the active version. */
  app.post('/api/sessions', (req, res) => {
    const b = req.body ?? {};
    const { session, created } = sessions.resume({
      funnelId: funnelOf(req),
      sessionId: b.sessionId,
      utm: b.utm,
      variantOverride: b.variant,
    });
    res.status(created ? 201 : 200).json({ created, ...withFunnel(session) });
  });

  app.get('/api/sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) throw new HttpError(404, 'Session not found');
    res.json(withFunnel(s));
  });

  app.put('/api/sessions/:id/state', (req, res) => {
    res.json({ session: sessions.saveState(req.params.id, req.body) });
  });

  app.post('/api/sessions/:id/result', (req, res) => {
    res.json(sessions.result(req.params.id));
  });

  /** Batch ingestion; always 200 with per-event outcome unless the envelope itself is malformed. */
  app.post('/api/events', (req, res) => {
    res.json(events.ingest(req.body));
  });

  // ---------------------------------------------------------------- internal API
  const admin = (req: Request, _res: Response, next: NextFunction) => {
    if (adminToken && req.get('x-admin-token') !== adminToken && req.query.token !== adminToken)
      return next(new HttpError(401, 'Admin token required'));
    next();
  };

  app.get('/api/admin/funnels/:funnelId', admin, (req, res) => {
    const id = req.params.funnelId as string;
    res.json({
      funnelId: id,
      activeVersion: versions.activeVersion(id),
      rollbackTarget: versions.activationStack(id).at(-2) ?? null,
      versions: versions.list(id),
      log: versions.log(id),
    });
  });

  app.get('/api/admin/funnels/:funnelId/versions/:version', admin, (req, res) => {
    res.json(versions.get(req.params.funnelId as string, Number(req.params.version)));
  });

  /** Upload a config (JSON body). `?publish=true` makes it active immediately. No redeploy involved. */
  app.post('/api/admin/versions', admin, (req, res) => {
    const { config, created } = versions.add(req.body);
    const published = req.query.publish === 'true' ? versions.activate(config.funnelId, config.version, 'publish') : null;
    res.status(created ? 201 : 200).json({ funnelId: config.funnelId, version: config.version, created, published });
  });

  app.post('/api/admin/funnels/:funnelId/versions/:version/publish', admin, (req, res) => {
    res.json(versions.activate(req.params.funnelId as string, Number(req.params.version), 'publish'));
  });

  app.post('/api/admin/funnels/:funnelId/rollback', admin, (req, res) => {
    res.json(versions.rollback(req.params.funnelId as string));
  });

  /** Config files shipped in the repo, for one-click import on the admin page. */
  app.get('/api/admin/bundled-configs', admin, (_req, res) => {
    const files = fs.existsSync(CONFIG_DIR) ? fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json')) : [];
    res.json(
      files.map((file) => {
        const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8'));
        return { file, funnelId: cfg.funnelId, version: cfg.version, releaseNote: cfg.releaseNote ?? null, config: cfg };
      }),
    );
  });

  app.get('/api/admin/analytics', admin, (req, res) => {
    const q = req.query;
    res.json(
      buildReport(db, versions, {
        funnelId: funnelOf(req),
        version: q.version ? Number(q.version) : null,
        campaign: q.campaign ? String(q.campaign) : null,
        excludeOverrides: q.excludeOverrides === 'true',
      }),
    );
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // ---------------------------------------------------------------- static SPA
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if ((err as { type?: string })?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return { app, versions, sessions, events };
}

/** First boot: import funnel-v1 from the repo and make it active. Later versions are published via the admin page/API. */
export function seed(versions: VersionStore, file = path.join(CONFIG_DIR, 'funnel-v1.json')) {
  if (versions.funnels().length || !fs.existsSync(file)) return;
  const { config } = versions.add(JSON.parse(fs.readFileSync(file, 'utf8')));
  versions.activate(config.funnelId, config.version, 'publish');
  console.log(`Seeded ${config.funnelId} v${config.version}`);
}
