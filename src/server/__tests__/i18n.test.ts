import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DICT,
  getLocale,
  loadPersistedLocale,
  setLocale,
  t,
  type Locale,
} from '../../web/i18n.js';

// Sprint 26 (i18n) / T4 — exercises the locale-state + translation +
// persistence helpers from `src/web/i18n.ts`. Uses the same Map-backed
// localStorage shim pattern as persist.test.ts so no jsdom dependency.

interface ShimStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
type StorageHost = { localStorage?: unknown };

let prevStorage: unknown;
let store: Map<string, string>;

beforeEach(() => {
  prevStorage = (globalThis as StorageHost).localStorage;
  store = new Map<string, string>();
  const shim: ShimStorage = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => { store.set(k, v); },
  };
  (globalThis as StorageHost).localStorage = shim;

  // Reset module state — `loadPersistedLocale()` reads from the (now-empty)
  // shim and installs the default 'ko'. Every test starts from this known
  // baseline so cross-test leakage can't mask regressions.
  loadPersistedLocale();
});

afterEach(() => {
  if (prevStorage === undefined) {
    delete (globalThis as StorageHost).localStorage;
  } else {
    (globalThis as StorageHost).localStorage = prevStorage;
  }
});

describe('t() lookup', () => {
  it('returns the value from the current locale dictionary', () => {
    // Default locale is ko after the reset in beforeEach.
    expect(t('sidebar.features')).toBe(DICT.ko['sidebar.features']);
  });

  it('returns the fallback string when the key is missing', () => {
    expect(t('does.not.exist', 'fallback value')).toBe('fallback value');
  });

  it('returns the key itself when neither the entry nor a fallback is provided', () => {
    // Surfaces *something* visible to the user instead of an empty span,
    // and makes missing keys easy to grep for in the wild.
    expect(t('totally.unknown')).toBe('totally.unknown');
  });

  it('returns the English entry after setLocale("en")', () => {
    setLocale('en');
    expect(t('sidebar.features')).toBe(DICT.en['sidebar.features']);
  });

  it("interpolates {placeholder} from the vars object", () => {
    // Stash a temporary template directly on the dict for the test. Avoids
    // depending on whatever T2 ships as flow.meta — keeps this assertion
    // about the interpolation primitive, not specific copy.
    const TEMP = '__test.greet';
    DICT.ko[TEMP] = '안녕, {name} ({count}회 방문)';
    DICT.en[TEMP] = 'Hi, {name} (visited {count} times)';
    try {
      expect(t(TEMP, { name: 'Sam', count: 3 })).toBe('안녕, Sam (3회 방문)');
      setLocale('en');
      expect(t(TEMP, { name: 'Sam', count: 3 })).toBe('Hi, Sam (visited 3 times)');
    } finally {
      delete DICT.ko[TEMP];
      delete DICT.en[TEMP];
    }
  });
});

describe('setLocale', () => {
  it('invokes the onChange callback when the locale actually changes', () => {
    let called = 0;
    setLocale('en', () => { called += 1; });
    expect(called).toBe(1);
    expect(getLocale()).toBe('en');
  });

  it("does not invoke onChange when setting to the current locale (no-op)", () => {
    // Already ko after beforeEach. Re-setting ko shouldn't trigger render().
    let called = 0;
    setLocale('ko', () => { called += 1; });
    expect(called).toBe(0);
  });

  it('persists the new locale to localStorage so the next load picks it up', () => {
    setLocale('en');
    expect(store.get('vibemate.locale')).toBe('en');
  });
});

describe('loadPersistedLocale', () => {
  it("hydrates from localStorage when a valid locale is stored", () => {
    store.set('vibemate.locale', 'en');
    loadPersistedLocale();
    expect(getLocale()).toBe('en');
  });

  it('falls back to ko when the stored value is not a valid locale', () => {
    // Defensive guard: a hand-edited or migrated value shouldn't crash the
    // UI; we silently coerce back to the default.
    store.set('vibemate.locale', 'fr');
    loadPersistedLocale();
    expect(getLocale()).toBe('ko');
  });

  it('defaults to ko when localStorage is unavailable', () => {
    delete (globalThis as StorageHost).localStorage;
    // Re-run hydration without storage; the module must not throw.
    expect(() => loadPersistedLocale()).not.toThrow();
    expect(getLocale()).toBe('ko');
  });
});

describe('dictionary completeness', () => {
  // The most common i18n regression is adding a ko entry and forgetting the
  // en mirror (or vice versa) — t() would silently fall back to the key for
  // the missing side. A symmetry check catches that at CI time.
  it('ko and en share the same key set', () => {
    const koKeys = Object.keys(DICT.ko).sort();
    const enKeys = Object.keys(DICT.en).sort();
    expect(koKeys).toEqual(enKeys);
  });

  it('every dictionary value is a non-empty string', () => {
    // Empty values would render as blank spans in the UI — also a regression
    // worth blocking. Iterate both locales since one might be partially filled.
    const allEntries = (['ko', 'en'] as const).flatMap((loc) =>
      Object.entries(DICT[loc]).map(([k, v]) => ({ loc, k, v })),
    );
    for (const { loc, k, v } of allEntries) {
      expect(typeof v, `${loc}:${k} should be a string`).toBe('string');
      expect(v.length, `${loc}:${k} should be non-empty`).toBeGreaterThan(0);
    }
  });
});

// Internal sanity — type stays a string union the tests can pin against.
// If T2 ever needs to add a third locale this assertion needs updating.
describe('Locale type', () => {
  it("'ko' and 'en' are valid Locale values", () => {
    const loc1: Locale = 'ko';
    const loc2: Locale = 'en';
    expect([loc1, loc2]).toEqual(['ko', 'en']);
  });
});
