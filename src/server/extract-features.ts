// Conventional-commit → feature extraction.
//
// Source: `sessions.summary` rows that came from `pm import-history`. We
// re-parse each summary as a conventional commit (`type(scope): subject`),
// bucket by (type, scope), and turn each qualifying group into a feature row
// — backfilling the contributing sessions' `feature_id` along the way.
//
// Boundary: this file owns parsing + extraction strategy. DB writes happen
// here too because the algorithm walks rows iteratively and we'd rather not
// pull yet another orchestration layer into domain.ts. domain.ts re-exports
// the public surface so callers have one entry point (matches git-import.ts).

import { getDb, transact, type DB } from './db.js';
import { makeSlug, now } from './lib.js';

// Conventional types we recognise by default. Whitelisted to avoid noise
// like `init:`, `wip:`, or commit messages that happen to start with a colon.
// Caller can override via opts.allowTypes.
export const CONVENTIONAL_TYPES: ReadonlyArray<string> = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'test',
  'chore', 'perf', 'build', 'ci', 'revert',
];

// Header pattern: type, optional `(scope)`, optional `!` (breaking marker),
// `:`, whitespace, subject. Only the FIRST line of the message is supplied
// (sessions.summary is git's `%s`, which is already first-line-only).
const HEADER_RE = /^([a-z]+)(?:\(([^)]+)\))?(!?):\s+(.+)$/;

export interface ConventionalCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  subject: string;
}

/**
 * Parse one commit subject as a conventional commit header. Returns null when
 * the line doesn't fit the pattern — caller treats that as "not a conventional
 * commit" and skips the row.
 *
 * Korean / non-ASCII subjects pass through unchanged — only the structural
 * head (type / scope / `!` / `:`) is matched in ASCII.
 */
export function parseConventionalCommit(subject: string): ConventionalCommit | null {
  const m = subject.match(HEADER_RE);
  if (!m) return null;
  const [, type, scope, bang, body] = m as [string, string, string | undefined, string, string];
  return {
    type,
    scope: scope ?? null,
    breaking: bang === '!',
    subject: body.trim(),
  };
}

export interface ExtractFeaturesOpts {
  /** Subset of types to extract. Default = CONVENTIONAL_TYPES. (conventional mode only) */
  allowTypes?: string[];
  /** Min commits per (type, scope) group to qualify as a feature. Default 2. */
  minCount?: number;
  /** When true, scope-less commits are also bucketed (by type alone). (conventional mode only) */
  includeUntyped?: boolean;
  /** When true, classify and report counts but skip all writes. */
  dryRun?: boolean;

  /**
   * Custom regex (string source) to parse session.summary instead of the
   * conventional commit grammar. When set, conventional parsing is bypassed
   * entirely — `allowTypes` and `includeUntyped` are ignored.
   *
   * Group resolution: if the regex has a named group `<scope>` we use that;
   * otherwise we use capture group 1. A regex without any capture group is
   * rejected at validation time.
   *
   * source_signature for these groups becomes `${customPatternType ?? 'custom'}:${scope}`,
   * which lives in a separate namespace from conventional `feat:auth` etc.
   */
  customPattern?: string;
  /**
   * Type-prefix used in the source_signature when `customPattern` is set.
   * Defaults to `'custom'`. Free-form (no whitelist) but cannot contain `:`
   * since that's the signature separator.
   */
  customPatternType?: string;
}

/** Hard cap on `customPattern` length. Generous for legit patterns; raises
 *  the bar against accidental ReDoS by limiting the input surface. */
const MAX_PATTERN_LENGTH = 200;

/**
 * Pull a scope out of a single subject using a pre-compiled custom regex.
 * Returns null on miss (no match, or matched but the captured scope is
 * empty / whitespace). Caller is responsible for compiling + validating
 * the regex once and passing it in.
 */
export function parseCustomPattern(re: RegExp, subject: string): { scope: string } | null {
  const m = subject.match(re);
  if (!m) return null;
  const raw = m.groups?.scope ?? m[1];
  if (!raw) return null;
  const scope = raw.trim();
  if (!scope) return null;
  return { scope };
}

/**
 * Compile + validate a user-supplied pattern. Throws with a user-facing
 * message on syntax errors, missing capture groups, or when the
 * accompanying patternType is malformed (would break source_signature).
 */
function compileCustomPattern(
  pattern: string,
  patternType: string | undefined,
): { re: RegExp; signaturePrefix: string } {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`--pattern exceeds ${MAX_PATTERN_LENGTH}-char limit`);
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid --pattern regex: ${(e as Error).message}`);
  }

  // Detect at least one capture group. Named `(?<x>...)` and plain `(...)`
  // both qualify. We exclude non-capturing `(?:...)`, lookahead `(?=...)`,
  // and lookbehind `(?<=...)` / `(?<!...)`.
  //
  // The check operates on `re.source` rather than walking parsed AST — we
  // strip escaped `\(` first, then count `(` that are NOT followed by `?:`
  // / `?=` / `?!` / `?<=` / `?<!`. Negative-lookahead does the work.
  const sourceWithoutEscapedParens = re.source.replace(/\\./g, '');
  const captureGroupCount = (
    sourceWithoutEscapedParens.match(/\((?!\?(?:[:!=]|<[!=]))/g) ?? []
  ).length;
  if (captureGroupCount === 0) {
    throw new Error('--pattern must have at least one capture group (named <scope> or group 1)');
  }

  const signaturePrefix = (patternType ?? 'custom').trim();
  if (!signaturePrefix) {
    throw new Error('--pattern-type must not be empty');
  }
  if (signaturePrefix.includes(':')) {
    throw new Error('--pattern-type must not contain ":" (signature separator)');
  }

  return { re, signaturePrefix };
}

export interface ExtractedGroup {
  /** Idempotency key — `${type}:${scope}` or `${type}:__notype__`. */
  signature: string;
  type: string;
  scope: string | null;
  /** Suggested feature name (= scope, or type when scope is null). */
  proposedName: string;
  commitCount: number;
  /** session ids contributing to this group, in DB-order. */
  sessionIds: string[];
  /** True when this group ended in a created (or merged-into) feature. */
  applied: boolean;
  /** Resolved feature id (set after apply; unset on dry-run / under-threshold). */
  featureId?: string;
  /** What happened during apply for this group. */
  outcome: 'created' | 'merged' | 'skipped' | 'under-threshold' | 'dry-run';
}

export interface ExtractFeaturesResult {
  groups: ExtractedGroup[];
  /** Newly-created feature rows. */
  created: number;
  /** Existing features matched by case-insensitive name. */
  merged: number;
  /** Already-known signatures (idempotent skip on the feature row). */
  skipped: number;
  /** Sessions whose `feature_id` was set (NULL → group's feature). */
  sessionsBackfilled: number;
}

/**
 * Walk all `sessions` rows for `projectId`, bucket conventional-commit
 * subjects by `(type, scope)`, and turn each qualifying group into a feature.
 *
 * The function is the single transactional unit — either every group's feature
 * row, idempotency marker, and session backfill all land, or none of it.
 *
 * Pre-existing manual sessions (not imported from git) are still scanned —
 * if their summary happens to match the conventional pattern they get pulled
 * into the same group. We don't filter to imported_commits because the
 * pattern is general purpose and a manually-named session like
 * "feat(auth): wired up SMS provider" should also count.
 */
export function extractFeaturesFromCommits(
  projectId: string,
  opts: ExtractFeaturesOpts = {},
): ExtractFeaturesResult {
  const db = getDb();
  const minCount = Math.max(1, Math.floor(opts.minCount ?? 2));

  // Project must exist; bail loudly so the caller can surface a clean error.
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  // Mode dispatch. customPattern wins exclusively — when set, conventional
  // grammar (and `allowTypes` / `includeUntyped`) is ignored. This keeps the
  // mental model simple: one extraction per invocation, no implicit OR.
  let parse: (summary: string) => { type: string; scope: string } | null;
  if (opts.customPattern != null && opts.customPattern.length > 0) {
    const { re, signaturePrefix } = compileCustomPattern(opts.customPattern, opts.customPatternType);
    parse = (summary) => {
      const got = parseCustomPattern(re, summary);
      if (!got) return null;
      return { type: signaturePrefix, scope: got.scope };
    };
  } else {
    const allow = new Set(opts.allowTypes ?? CONVENTIONAL_TYPES);
    const includeUntyped = opts.includeUntyped === true;
    parse = (summary) => {
      const c = parseConventionalCommit(summary);
      if (!c) return null;
      if (!allow.has(c.type)) return null;
      if (c.scope == null && !includeUntyped) return null;
      return { type: c.type, scope: c.scope ?? '__notype__' };
    };
  }

  // 1. Pull every session's id + summary in start order. We iterate this in
  // memory rather than crafting a SQL group-by because the bucketing key
  // comes from a regex applied to the summary text — easier in JS.
  const rows = db
    .prepare(
      `SELECT id, summary FROM sessions
        WHERE project_id = ? AND summary IS NOT NULL
        ORDER BY started_at ASC`,
    )
    .all(projectId) as Array<{ id: string; summary: string }>;

  // 2. Bucket by signature.
  const buckets = new Map<string, ExtractedGroup>();
  for (const r of rows) {
    const parsed = parse(r.summary);
    if (!parsed) continue;

    const signature = `${parsed.type}:${parsed.scope}`;
    // Restore null for the conventional sentinel so the rendered group keeps
    // the original `scope: null` semantics (used by proposedName fallback
    // and downstream display).
    const displayScope = parsed.scope === '__notype__' ? null : parsed.scope;
    let g = buckets.get(signature);
    if (!g) {
      g = {
        signature,
        type: parsed.type,
        scope: displayScope,
        proposedName: displayScope ?? parsed.type,
        commitCount: 0,
        sessionIds: [],
        applied: false,
        outcome: 'under-threshold',
      };
      buckets.set(signature, g);
    }
    g.commitCount++;
    g.sessionIds.push(r.id);
  }

  // 3. Threshold filter — record outcome but keep the group object so the
  // caller can see what was considered. Anything below `minCount` reports
  // `under-threshold` and never enters the apply loop.
  const groups = Array.from(buckets.values());
  const qualifying = groups.filter((g) => g.commitCount >= minCount);

  const result: ExtractFeaturesResult = {
    groups,
    created: 0,
    merged: 0,
    skipped: 0,
    sessionsBackfilled: 0,
  };

  if (opts.dryRun) {
    for (const g of qualifying) {
      g.outcome = 'dry-run';
    }
    return result;
  }

  // 4. Apply within one transaction. The order is: lookup marker → lookup
  // existing feature by name → create — at any step we may decide which
  // feature_id to attach. Then we backfill sessions in bulk.
  transact(db, () => {
    for (const g of qualifying) {
      const featureId = resolveOrCreateFeature(db, projectId, g, result);
      g.featureId = featureId;
      g.applied = true;
      // Backfill: only sessions whose feature_id is currently NULL — preserves
      // any prior manual / endSession-auto mapping the user trusts.
      result.sessionsBackfilled += backfillSessions(db, featureId, g.sessionIds);
    }
  });

  return result;
}

/**
 * Decide which feature row a group should attach to and update bookkeeping
 * on the result. Returns the resolved feature id.
 *
 *   1. extracted_features lookup → reuse prior id, set outcome='skipped'.
 *   2. case-insensitive features.name match → reuse, set 'merged'.
 *   3. otherwise create a fresh row, set 'created'.
 *
 * In all paths we INSERT OR REPLACE the marker so subsequent runs are stable.
 */
function resolveOrCreateFeature(
  db: DB,
  projectId: string,
  g: ExtractedGroup,
  acc: ExtractFeaturesResult,
): string {
  const existingMarker = db
    .prepare('SELECT feature_id FROM extracted_features WHERE project_id = ? AND source_signature = ?')
    .get(projectId, g.signature) as { feature_id: string } | undefined;
  if (existingMarker) {
    g.outcome = 'skipped';
    acc.skipped++;
    return existingMarker.feature_id;
  }

  // Case-insensitive name match. We compare the proposed name (scope or type)
  // against features.name in lowercase — a user who set up `auth` manually
  // and later imports `feat(auth):` commits gets the sessions backfilled into
  // their existing feature instead of a duplicate.
  const matched = db
    .prepare('SELECT id FROM features WHERE project_id = ? AND LOWER(name) = LOWER(?)')
    .get(projectId, g.proposedName) as { id: string } | undefined;

  let featureId: string;
  if (matched) {
    featureId = matched.id;
    g.outcome = 'merged';
    acc.merged++;
  } else {
    featureId = createFeatureRow(db, projectId, g);
    g.outcome = 'created';
    acc.created++;
  }

  db.prepare(
    `INSERT INTO extracted_features (project_id, source_signature, feature_id, extracted_at)
     VALUES (?, ?, ?, ?)`,
  ).run(projectId, g.signature, featureId, now());

  return featureId;
}

function createFeatureRow(db: DB, projectId: string, g: ExtractedGroup): string {
  // Slug uniqueness: respect already-taken slugs in this project. lib.makeSlug
  // does the suffixing.
  const taken = new Set(
    (db.prepare('SELECT id FROM features WHERE project_id = ?').all(projectId) as { id: string }[])
      .map((r) => r.id),
  );
  const id = makeSlug(g.proposedName, taken);
  const t = now();
  const goal = `Auto-extracted from ${g.commitCount} commits with prefix \`${g.type}${g.scope ? `(${g.scope})` : ''}:\``;
  db.prepare(
    `INSERT INTO features (id, project_id, name, goal, spec_md, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'todo', 0, ?, ?)`,
  ).run(id, projectId, g.proposedName, goal, t, t);
  return id;
}

/**
 * UPDATE sessions.feature_id for the given session ids — but only those that
 * are currently NULL. Returns the count of rows actually changed.
 *
 * SQLite doesn't expose `RETURNING COUNT` portably, so we read `changes()`
 * on the connection right after the statement. The single transaction this
 * runs inside means no other writer can race in between.
 */
function backfillSessions(db: DB, featureId: string, sessionIds: string[]): number {
  if (sessionIds.length === 0) return 0;
  // Build an `IN (?, ?, …)` placeholder list. node:sqlite caps parameters at
  // SQLITE_LIMIT_VARIABLE_NUMBER (default ~32K). Sessions per group will be
  // tens to low hundreds in practice, so a single statement is fine.
  const placeholders = sessionIds.map(() => '?').join(',');
  const stmt = db.prepare(
    `UPDATE sessions SET feature_id = ?
       WHERE id IN (${placeholders}) AND feature_id IS NULL`,
  );
  const info = stmt.run(featureId, ...sessionIds);
  return Number(info.changes) || 0;
}
