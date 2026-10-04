import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import type { FunnelConfig } from '../shared/types.js';

export const loadConfig = (v: number): FunnelConfig =>
  JSON.parse(fs.readFileSync(path.resolve('configs', `funnel-v${v}.json`), 'utf8'));

export function setup({ publish = [1] }: { publish?: number[] } = {}) {
  const db = openDb(':memory:');
  const ctx = createApp({ db });
  for (const v of publish) {
    ctx.versions.add(loadConfig(v));
    ctx.versions.activate('workstyle-planner', v, 'publish');
  }
  const api = request(ctx.app);
  return { ...ctx, db, api };
}

let n = 0;
export const eid = (prefix = 'evt') => `${prefix}-${Date.now().toString(36)}-${(n++).toString().padStart(6, '0')}`;
