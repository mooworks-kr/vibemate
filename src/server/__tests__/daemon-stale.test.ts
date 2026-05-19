import { describe, expect, it } from 'vitest';
import { classifyStaleness } from '../daemon.js';

// Sprint 29 (mh48) — pure-helper unit. `classifyStaleness` takes
// ms-since-epoch (or null) for the two witnesses and returns a verdict;
// no FS / no clock. Exercising every cell of the truth table here is
// cheap and means the CLI surface only has to assert on the formatting,
// not the comparison logic.

describe('classifyStaleness', () => {
  it("returns 'stale' when the build is newer than the daemon", () => {
    expect(
      classifyStaleness({ daemonStartedAt: 1000, buildMtime: 2000 }),
    ).toBe('stale');
  });

  it("returns 'fresh' when the daemon started after the last build", () => {
    expect(
      classifyStaleness({ daemonStartedAt: 2000, buildMtime: 1000 }),
    ).toBe('fresh');
  });

  it("treats equal mtimes as 'fresh' (no nag on same-second rebuilds)", () => {
    // Tie-break direction matters: a TS rebuild that completes within the
    // same second the daemon was started should not flap to stale.
    expect(
      classifyStaleness({ daemonStartedAt: 1500, buildMtime: 1500 }),
    ).toBe('fresh');
  });

  it("returns 'unknown' when the daemon-start witness is missing", () => {
    expect(
      classifyStaleness({ daemonStartedAt: null, buildMtime: 1000 }),
    ).toBe('unknown');
  });

  it("returns 'unknown' when the build witness is missing (dev mode)", () => {
    // tsx-watch dev path: no dist/server/http.js exists, so we can't compare.
    expect(
      classifyStaleness({ daemonStartedAt: 1000, buildMtime: null }),
    ).toBe('unknown');
  });

  it("returns 'unknown' when both witnesses are missing", () => {
    expect(
      classifyStaleness({ daemonStartedAt: null, buildMtime: null }),
    ).toBe('unknown');
  });

  it('handles realistic ms-since-epoch values', () => {
    // Smoke check on the actual magnitude of numbers we'll see in
    // production (Date.now() at write-time). Catches accidental
    // sign-flipping / unit confusion regressions.
    const day = 86_400_000;
    const t0 = Date.now();
    expect(
      classifyStaleness({ daemonStartedAt: t0 - day, buildMtime: t0 }),
    ).toBe('stale');
    expect(
      classifyStaleness({ daemonStartedAt: t0, buildMtime: t0 - day }),
    ).toBe('fresh');
  });
});
