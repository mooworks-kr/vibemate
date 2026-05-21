import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from './lib.js';

// Sprint 30 (wkq6, ADR-0027): the first persistent config file we ship. Used
// by daemon (bind host), http (auth token), and cli (token / server commands).
// Intentionally NOT touched by domain.ts — the data layer stays
// config-oblivious so unit tests don't need to mock the filesystem.

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
}

/**
 * Default config returned when no file exists yet OR a field is missing.
 * Each call returns a fresh object so callers can mutate safely.
 */
export function defaultConfig(): Config {
  return {
    server: { host: '127.0.0.1', token: null },
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
 * (e.g. legacy `remote.*` from prior versions) are silently dropped.
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
  return out;
}
