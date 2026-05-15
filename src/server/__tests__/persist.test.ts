import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readPersistedFlag,
  writePersistedFlag,
  readPersistedString,
  writePersistedString,
} from '../../web/persist.js';

// Pure helpers reach `globalThis.localStorage` at call time, so a tiny
// Map-backed shim is enough to round-trip flags from Node — no jsdom needed.
// Each test installs a fresh shim and restores the previous binding after.
//
// `as unknown as Storage` keeps the cast confined to the test boundary; the
// helper file declares its own minimal Storage shape internally.
interface ShimStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
type StorageHost = { localStorage?: unknown };

let prevStorage: unknown;
let store: Map<string, string>;
let throwOnSet = false;
let throwOnGet = false;

beforeEach(() => {
  prevStorage = (globalThis as StorageHost).localStorage;
  store = new Map<string, string>();
  throwOnSet = false;
  throwOnGet = false;
  const shim: ShimStorage = {
    getItem: (k) => {
      if (throwOnGet) throw new Error('storage disabled');
      return store.has(k) ? store.get(k)! : null;
    },
    setItem: (k, v) => {
      if (throwOnSet) throw new Error('quota exceeded');
      store.set(k, v);
    },
  };
  (globalThis as StorageHost).localStorage = shim;
});

afterEach(() => {
  if (prevStorage === undefined) {
    delete (globalThis as StorageHost).localStorage;
  } else {
    (globalThis as StorageHost).localStorage = prevStorage;
  }
});

describe('readPersistedFlag', () => {
  it("returns the fallback when the key isn't set", () => {
    expect(readPersistedFlag('missing', true)).toBe(true);
    expect(readPersistedFlag('missing', false)).toBe(false);
  });

  it("parses '1' / '0' as true / false", () => {
    store.set('k', '1');
    expect(readPersistedFlag('k', false)).toBe(true);
    store.set('k', '0');
    expect(readPersistedFlag('k', true)).toBe(false);
  });

  it("also accepts 'true' / 'false' (forwards-compat with hand edits)", () => {
    store.set('k', 'true');
    expect(readPersistedFlag('k', false)).toBe(true);
    store.set('k', 'false');
    expect(readPersistedFlag('k', true)).toBe(false);
  });

  it('returns the fallback for garbage values rather than coercing', () => {
    // Belt-and-suspenders: a stray edit like 'yes' or '' must not flip
    // the user's setting silently. We prefer the default over a guess.
    store.set('k', 'yes');
    expect(readPersistedFlag('k', false)).toBe(false);
    expect(readPersistedFlag('k', true)).toBe(true);
    store.set('k', '');
    expect(readPersistedFlag('k', true)).toBe(true);
  });

  it('swallows getItem errors and returns the fallback', () => {
    throwOnGet = true;
    // Even though `localStorage` exists, getItem throws (mirrors what some
    // browsers do in private mode or with site data disabled). Helper must
    // not propagate — the toggle still works in-memory for the session.
    expect(readPersistedFlag('k', true)).toBe(true);
    expect(readPersistedFlag('k', false)).toBe(false);
  });

  it('returns the fallback when localStorage is absent entirely (SSR / Node)', () => {
    delete (globalThis as StorageHost).localStorage;
    expect(readPersistedFlag('k', true)).toBe(true);
  });
});

describe('writePersistedFlag', () => {
  it("encodes true / false as '1' / '0' so read* can round-trip them", () => {
    writePersistedFlag('k', true);
    expect(store.get('k')).toBe('1');
    writePersistedFlag('k', false);
    expect(store.get('k')).toBe('0');
  });

  it('round-trips: write then read returns the same value', () => {
    writePersistedFlag('k', true);
    expect(readPersistedFlag('k', false)).toBe(true);

    writePersistedFlag('k', false);
    expect(readPersistedFlag('k', true)).toBe(false);
  });

  it('is a no-op when localStorage is unavailable (Node default)', () => {
    delete (globalThis as StorageHost).localStorage;
    expect(() => writePersistedFlag('k', true)).not.toThrow();
  });

  it('swallows setItem errors (quota / disabled storage)', () => {
    throwOnSet = true;
    expect(() => writePersistedFlag('k', true)).not.toThrow();
    // And nothing got persisted.
    expect(store.has('k')).toBe(false);
  });
});

describe('readPersistedString / writePersistedString', () => {
  it('round-trips a non-empty string', () => {
    writePersistedString('proj', 'vibemate');
    expect(readPersistedString('proj', null)).toBe('vibemate');
  });

  it('returns the fallback when the key is missing', () => {
    expect(readPersistedString('missing', 'default')).toBe('default');
    expect(readPersistedString('missing', null)).toBeNull();
  });

  it('treats empty string as missing (returns fallback)', () => {
    // Empty is what writePersistedString stores when value is null —
    // readers should never see "" as a valid project id.
    store.set('proj', '');
    expect(readPersistedString('proj', 'fallback')).toBe('fallback');
  });

  it('writePersistedString(null) clears the slot', () => {
    writePersistedString('proj', 'vibemate');
    writePersistedString('proj', null);
    expect(readPersistedString('proj', 'fallback')).toBe('fallback');
  });

  it('survives storage being absent (Node SSR)', () => {
    delete (globalThis as StorageHost).localStorage;
    expect(() => writePersistedString('proj', 'x')).not.toThrow();
    expect(readPersistedString('proj', 'fallback')).toBe('fallback');
  });

  it('swallows getItem / setItem errors', () => {
    throwOnGet = true;
    expect(readPersistedString('proj', 'fallback')).toBe('fallback');
    throwOnGet = false;
    throwOnSet = true;
    expect(() => writePersistedString('proj', 'x')).not.toThrow();
  });
});
