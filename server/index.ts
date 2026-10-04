import path from 'node:path';
import { openDb } from './db.js';
import { createApp, seed } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const db = openDb();
const { app, versions } = createApp({
  db,
  adminToken: process.env.ADMIN_TOKEN || undefined,
  staticDir: path.resolve('dist', 'client'),
});
seed(versions);

app.listen(port, () => {
  console.log(`Funnel platform on http://localhost:${port}`);
  if (!process.env.ADMIN_TOKEN) console.log('ADMIN_TOKEN is not set: /admin and /dashboard are open (dev mode).');
});
