import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from './lib.js';

// Sprint 30 (wkq6, ADR-0027): the first persistent config file we ship. Used
// by daemon (bind host), http (auth token), mcp (remote mode), and cli
// (token / remote / server commands). Intentionally NOT touched by domain.ts —
// the data layer stays config-oblivious so unit tests don't need to mock
// the filesystem.
//
// Schema is flat-ish on purpose:
//   * `server.*`  — settings consumed when this machine *is* the daemon
//   * `remote.*`  — settings consumed when this machine *talks to* a daemon
// A laptop in remote mode generally has empty `server` and populated
// `remote`; the home daemon has populated `server` and empty `remote`.
// Same file shape on both sides makes copy-paste config easier.

export interface Config {
  server: {
    /** Address the HTTP daemon binds to. Default 127.0.0.1 keeps it
     *  loopback-only — opening to the LAN requires explicit `pm server
     *  bind 0.0.0.0` (or a tailscale IP). */
    host: string;
    /** Bearer token the daemon enforces on `/api/*`. null = auth disabled
     *  (loopback-friendly default — zero friction for existing users). */
    token: string | null;
  };
  remote: {
    /** Base URL the laptop-side MCP forwards to (e.g.
     *  `http://100.x.y.z:7321`). null = local mode. */
    url: string | null;
    /** Bearer token the laptop sends. null = unauthenticated requests
     *  (works when the remote daemon also has no token). */
    token: string | null;
  };
}

/**
 * Default config returned when no file exists yet OR a field is missing.
 * Each call returns a fresh object so callers can mutate safely.
 */
export function defaultConfig(): Config {
  return {
    server: { host: '127.0.0.1', token: null },
    remote: { url: null, token: null },
  };
}

/**
 * Path to the on-disk config. Lives next to `db.sqlite` so a single
 * `HOME` swap (the pattern E2E tests already use) isolates both. The
 * containing directory is created lazily by `saveConfig`.
 */
export function getConfigPath(): string {
  return path.join(defaultDataDir(), 'config.json');
}

/**
 * Read the config from disk. Missing file / parse failure both return the
 * default — we never throw here so daemon / mcp / cli startup is robust
 * against a freshly-installed user with no config at all. Unknown keys
 * survive a roundtrip (we don't strip), so a Phase-2 user with extra
 * fields can still run Phase-1 code without losing data.
 */
export function loadConfig(filePath: string = getConfigPath()): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return defaultConfig();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt file — fall back rather than blowing up the process.
    return defaultConfig();
  }
  return mergeConfig(defaultConfig(), parsed);
}

/**
 * Write a (deeply-merged) patch to disk. Caller passes the leaves they
 * want changed; everything else is left alone. Returns the resulting
 * config so callers can read-back without a second `loadConfig()`.
 *
 * Creates the parent directory if needed. File mode 0600 (owner-only) —
 * the token is a secret and we don't want it world-readable.
 */
export function saveConfig(
  patch: DeepPartial<Config>,
  filePath: string = getConfigPath(),
): Config {
  const current = loadConfig(filePath);
  const next = mergeConfig(current, patch);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n', {
    mode: 0o600,
  });
  return next;
}

// ----- internals -------------------------------------------------------

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursive merge that preserves user-set nulls (so `pm token clear`
 * works — null doesn't mean "use default", it means "remove"). Unknown
 * keys on either side survive.
 */
function mergeConfig(base: Config, patch: unknown): Config {
  if (!isPlainObject(patch)) return base;
  const out: Config = {
    server: { ...base.server },
    remote: { ...base.remote },
  };
  if (isPlainObject(patch.server)) {
    if ('host' in patch.server && typeof patch.server.host === 'string') {
      out.server.host = patch.server.host;
    }
    if ('token' in patch.server) {
      const v = patch.server.token;
      out.server.token = typeof v === 'string' ? v : null;
    }
  }
  if (isPlainObject(patch.remote)) {
    if ('url' in patch.remote) {
      const v = patch.remote.url;
      out.remote.url = typeof v === 'string' ? v : null;
    }
    if ('token' in patch.remote) {
      const v = patch.remote.token;
      out.remote.token = typeof v === 'string' ? v : null;
    }
  }
  return out;
}
