// Tiny localStorage-backed flag persistence.
//
// Lives in src/web/ because only the web bundle calls it at runtime, but it
// stays runtime-import-free of any DOM-specific API surface — `localStorage`
// is reached via `globalThis` at call time, so server-side unit tests can
// stub a Map-backed shim in and round-trip flags without needing jsdom.
//
// Why a separate helper instead of inline `localStorage.setItem` calls:
//   * Centralises the try/catch for private-mode / quota / disabled-storage
//     failures (otherwise duplicated at every call site).
//   * Single string-encoding choice ('1' / '0') so writers and readers can't
//     drift apart.
//   * Unit-testable under the existing Node-only vitest setup — see
//     `src/server/__tests__/persist.test.ts`.

/** Minimal Storage shape we actually need. Declared locally so this module
 *  typechecks under both the root tsconfig (DOM lib present) and the test
 *  tsconfig (Node-only, no DOM types). */
interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getStorage(): MinimalStorage | null {
  // `as` cast keeps this module agnostic of whether `localStorage` exists in
  // the ambient lib; at runtime it's `undefined` in Node and a real Storage
  // in browsers. Either way we never throw on the access itself.
  const g = globalThis as { localStorage?: MinimalStorage };
  return g.localStorage ?? null;
}

/**
 * Read a persisted boolean flag from localStorage.
 *
 * Returns `fallback` when the key is missing, the value can't be parsed, or
 * localStorage itself is unavailable / throws (private mode, quota, SSR).
 * Accepted truthy strings: `'1'`, `'true'`. Falsy: `'0'`, `'false'`.
 */
export function readPersistedFlag(key: string, fallback: boolean): boolean {
  try {
    const storage = getStorage();
    if (!storage) return fallback;
    const raw = storage.getItem(key);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Persist a boolean flag. Best-effort — on failure (private mode, quota,
 * disabled storage) the toggle still works for the current session, just
 * not across reloads.
 */
export function writePersistedFlag(key: string, value: boolean): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(key, value ? '1' : '0');
  } catch {
    // intentional swallow — caller's UI flow shouldn't break on storage errors
  }
}

/**
 * Read a persisted string. Returns `fallback` when the key is missing or
 * storage is unavailable. Empty string is treated as missing — callers
 * almost always want the fallback over a literal empty value.
 */
export function readPersistedString(key: string, fallback: string | null): string | null {
  try {
    const storage = getStorage();
    if (!storage) return fallback;
    const raw = storage.getItem(key);
    return raw && raw.length > 0 ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function writePersistedString(key: string, value: string | null): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    if (value === null || value.length === 0) {
      storage.setItem(key, '');
      return;
    }
    storage.setItem(key, value);
  } catch {
    // intentional swallow
  }
}
