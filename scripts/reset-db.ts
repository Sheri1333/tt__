import fs from 'node:fs';
import path from 'node:path';

// Local-only helper: deletes the SQLite file. Next server start re-seeds funnel-v1.
const file = process.env.DB_FILE ?? path.resolve('data', 'funnel.db');
for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
console.log(`Removed ${file}`);
