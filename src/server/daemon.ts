import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from './lib.js';
import { startHttpServer } from './http.js';
import { loadConfig } from './config.js';

// Sprint 21 (zxl3, ADR-0019): chokidar file watcher retired. The daemon's
// sole job is now the HTTP server + PID-file housekeeping. `session_files`
// is derived at endSession time via `git status --porcelain` instead — see
// domain.ts:endSession.

export const PID_FILE = path.join(defaultDataDir(), 'daemon.pid');

// Sprint 29 (mh48): the file we stat to derive "current build mtime".
// `http.js` was picked over a server-tree sum because (a) it's the file most
// HTTP-route changes touch and (b) keeping the witness single-purpose makes
// the staleness rule trivial to explain to users. Resolves both in prod
// (`dist/server/http.js`, alongside this file) and in dev (`src/server/http.ts`
// — the .js path here won't exist, which `buildMtimeMs()` reports as null).
const HTTP_BUILD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'http.js',
);

export async function startDaemon(port: number = 7321): Promise<void> {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });

  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
    if (isProcessAlive(existingPid)) {
      console.log(`[vibemate] daemon already running (pid ${existingPid})`);
      return;
    }
    fs.unlinkSync(PID_FILE);
  }

  fs.writeFileSync(PID_FILE, String(process.pid));

  // Sprint 30 (wkq6 / ADR-0027): pull bind host + auth token from
  // ~/.vibemate/config.json. Defaults (127.0.0.1, no token) preserve the
  // pre-Sprint-30 behavior for users who never touch the file.
  const config = loadConfig();
  startHttpServer({
    port,
    hostname: config.server.host,
    authToken: config.server.token,
  });

  const cleanup = (): void => {
    console.log('[vibemate] shutting down…');
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

export function stopDaemon(): boolean {
  if (!fs.existsSync(PID_FILE)) {
    console.log('[vibemate] no daemon running');
    return false;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[vibemate] sent SIGTERM to pid ${pid}`);
    return true;
  } catch (err) {
    console.log('[vibemate] daemon process not found, cleaning up pid file');
    fs.unlinkSync(PID_FILE);
    return false;
  }
}

export function daemonStatus(): { running: boolean; pid?: number } {
  if (!fs.existsSync(PID_FILE)) return { running: false };
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
  if (isProcessAlive(pid)) return { running: true, pid };
  return { running: false };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Sprint 29 (mh48) — stale-build detection
//
// Hazard: a daemon launched from build N keeps running build N's code in
// memory even after `npm run build` overwrites dist/. Until the user
// restarts the process they see ghost 404s on new routes (the pax6 trigger
// case: /api/projects/:id/deletion-impact landed in build N+1 but the live
// daemon was still N). ADR-0026 picks explicit `pm restart` + a status
// warning over auto-reload — auto-reload would drop in-flight requests
// silently.
//
// Mechanism: compare `dist/server/http.js` mtime (the build clock) against
// the PID file mtime (the daemon clock — the PID file is written exactly
// once at startDaemon() and removed at cleanup, so its mtime is a faithful
// proxy for daemon start time). Pure, ms-in-ms-out, so cli/tests can
// exercise it without filesystem fixtures.
// ============================================================

export type StaleVerdict = 'fresh' | 'stale' | 'unknown';

/**
 * Pure verdict helper. Inputs are ms-since-epoch (or null when the witness
 * file is missing, e.g. dev mode without a build).
 *
 *   stale   = build is newer than daemon (the typical "forgot to restart")
 *   fresh   = daemon started after the last build (clean state)
 *   unknown = at least one side has no witness (dev mode, daemon down)
 *
 * Equal mtimes are treated as fresh — re-running `npm run build` while the
 * daemon is alive but inside the same second shouldn't nag (the artifact
 * is identical at byte level in that window for typical TS rebuilds).
 */
export function classifyStaleness(opts: {
  daemonStartedAt: number | null;
  buildMtime: number | null;
}): StaleVerdict {
  if (opts.daemonStartedAt == null || opts.buildMtime == null) return 'unknown';
  return opts.buildMtime > opts.daemonStartedAt ? 'stale' : 'fresh';
}

/**
 * mtime of the daemon's PID file as ms-since-epoch, or null when the file
 * is missing. Caller is responsible for checking that the daemon is
 * actually alive (`daemonStatus().running`) — a stale PID with no process
 * behind it would still surface a number here.
 */
export function daemonStartedAtMs(): number | null {
  try {
    return fs.statSync(PID_FILE).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * mtime of the build witness (`dist/server/http.js`), or null when it
 * doesn't exist. In dev mode (tsx watch) the witness is absent — the
 * status command treats that as "no build to be stale against".
 */
export function buildMtimeMs(): number | null {
  try {
    return fs.statSync(HTTP_BUILD_PATH).mtimeMs;
  } catch {
    return null;
  }
}
