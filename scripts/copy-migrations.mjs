#!/usr/bin/env node
// Copy SQL migration files from src/server/migrations/ to dist/server/migrations/
// after tsc has emitted JS. tsc itself won't carry .sql files across, and the
// runner expects the SQL alongside the compiled migrations.js module.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src/server/migrations');
const dst = path.join(root, 'dist/server/migrations');

if (!fs.existsSync(src)) {
  console.error(`copy-migrations: source dir missing: ${src}`);
  process.exit(1);
}

fs.mkdirSync(dst, { recursive: true });

let copied = 0;
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith('.sql')) continue;
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  copied++;
}

console.log(`copy-migrations: ${copied} file(s) → dist/server/migrations/`);
