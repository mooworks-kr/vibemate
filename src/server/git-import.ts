// Git history → vibemate sessions import: spawn + parse layer.
//
// `domain.importGitHistory` orchestrates: it asks `runGitLog` for parsed
// commits then loops `domain.importGitCommit` for each. This file owns the
// child_process boundary so the domain layer stays unit-testable against a
// fixed Commit[] without spawning git.
//
// Safety:
//   * `child_process.spawn` is called with an explicit args array — no shell
//     interpolation. User-supplied `since` / `limit` therefore can't escape
//     into git arguments.
//   * Output is parsed as bytes; we use ASCII unit/record separators
//     (`\x1f` / `\x1e`) so commit messages with embedded newlines or quotes
//     can't break the framing.
//   * `--name-status -z` makes file paths NUL-terminated, so a path with
//     embedded newline or tab survives intact.

import { spawn } from 'node:child_process';
import type { EditType } from './types.js';

export interface ParsedFile {
  path: string;
  edit_type: EditType;
}

export interface ParsedCommit {
  hash: string;
  /** Author timestamp in ms since epoch (git emits seconds; we ×1000 here). */
  author_timestamp_ms: number;
  subject: string;
  body: string;
  files: ParsedFile[];
}

export interface RunGitLogOpts {
  /** Repo working tree. Passed as `cwd` to spawn. */
  rootPath: string;
  /** Equivalent of `git log --since=<value>`. ISO date or git rev. */
  since?: string;
  /** Equivalent of `--max-count=N`. Hard cap kept by caller. */
  limit?: number;
}

// Field separator inside a commit record (between hash / ts / subject / body).
const FIELD_SEP = '\x1f';
// Record separator between commit records.
const RECORD_SEP = '\x1e';
// Default safety cap so an accidental import on a huge repo doesn't
// pull tens of thousands of rows. Caller can override via opts.limit; CLI
// surfaces this via `--limit`.
export const DEFAULT_LIMIT = 1000;

/**
 * Map a `--name-status` letter to our session_files edit_type. Returns null
 * for status codes we deliberately skip (D = deletion has no row to attach
 * to in our flat model).
 */
export function mapStatusToEditType(status: string): EditType | null {
  // Rename / Copy carry a similarity score (e.g. R100, C75) — strip it.
  const code = status[0]!;
  switch (code) {
    case 'A': return 'created';
    case 'C': return 'created';   // Copy: new path is effectively a created file
    case 'M': return 'modified';
    case 'T': return 'modified';  // Type change (e.g., file → symlink)
    case 'R': return 'modified';  // Rename: track as modification at the new path
    case 'D': return null;        // Delete: no per-file row to attach
    default:  return null;        // Unknown: be conservative
  }
}

/**
 * Parse the raw output of:
 *   git log --format='%H<FS>%at<FS>%s<FS>%b<RS>' --name-status -z [...]
 *
 * Pure function — no I/O. Exposed for unit tests.
 *
 * Wire format (verified empirically against git 2.x):
 *   `H1<FS>T1<FS>S1<FS>B1<RS>\0\n<status>\0<path>\0...<status>\0<path>\0H2<FS>T2<FS>...`
 *
 * That is, after each commit's header (terminated by our RS) git emits one
 * NUL (the `-z` record terminator) and a newline, then the file list as
 * NUL-separated `status` and `path` tokens. The next commit's hash follows
 * immediately after the last path's terminating NUL — there's no header /
 * footer separator we can rely on. So we split first by RS to peel headers
 * off, then locate the boundary between "previous commit's files" and "next
 * commit's header" by scanning the inter-record bytes for the canonical
 * 40-hex-char hash pattern.
 *
 * For rename (`R<score>`) and copy (`C<score>`) entries git emits 3 tokens:
 * status, OLD path, NEW path. Plain entries are 2 tokens.
 */
export function parseGitLog(stdout: string): ParsedCommit[] {
  if (!stdout) return [];
  const HASH_THEN_FS = /([0-9a-fA-F]{40})\x1f/;

  // Step 1: peel headers off via RS. parts[0] is the first commit's header;
  // every parts[i] (i ≥ 1) starts with the previous commit's file list and,
  // unless this is the trailing slot, ends with the current commit's header.
  const parts = stdout.split(RECORD_SEP);

  const headers: string[] = [];
  const fileBlocks: string[] = []; // index aligned with headers

  // First header — no preceding file list.
  if (parts[0]) headers.push(parts[0]);

  for (let i = 1; i < parts.length; i++) {
    // Strip leading `\0\n` (the -z record terminator + the LF git inserts
    // before the file list section).
    const piece = parts[i]!.replace(/^\0\n?/, '');
    if (!piece) continue;

    // Find the next commit's header — 40 hex chars + FS. Anything before is
    // the previous commit's file list; anything from the match onward is
    // the next header.
    const m = piece.match(HASH_THEN_FS);
    if (m && m.index !== undefined) {
      const filesPart = piece.slice(0, m.index);
      const nextHeader = piece.slice(m.index);
      fileBlocks.push(filesPart);
      headers.push(nextHeader);
    } else {
      // No further header — this is the trailing file list for the last commit.
      fileBlocks.push(piece);
    }
  }

  const out: ParsedCommit[] = [];
  for (let i = 0; i < headers.length; i++) {
    const fields = headers[i]!.split(FIELD_SEP);
    if (fields.length < 4) continue;
    const [hash, atSec, subject, body] = fields as [string, string, string, string];
    const tsSec = Number(atSec);
    if (!hash || !Number.isFinite(tsSec)) continue;

    const files: ParsedFile[] = [];
    const tokens = (fileBlocks[i] ?? '')
      .split('\0')
      .filter((tok) => tok.length > 0);

    let j = 0;
    while (j < tokens.length) {
      const status = tokens[j]!;
      const editType = mapStatusToEditType(status);
      const head = status[0];
      if (head === 'R' || head === 'C') {
        // 3-token entry: status, OLD, NEW. We track the NEW path.
        const newPath = tokens[j + 2];
        if (newPath != null && editType != null) {
          files.push({ path: newPath, edit_type: editType });
        }
        j += 3;
      } else {
        const filePath = tokens[j + 1];
        if (filePath != null && editType != null) {
          files.push({ path: filePath, edit_type: editType });
        }
        j += 2;
      }
    }

    out.push({
      hash,
      author_timestamp_ms: tsSec * 1000,
      subject: subject.trim(),
      body: body.replace(/\n+$/, ''),
      files,
    });
  }
  return out;
}

/**
 * Spawn `git log` with the safe argument array and return the parsed commits.
 * Throws when `git` exits non-zero (e.g. not a git repo, bad ref).
 */
export function runGitLog(opts: RunGitLogOpts): Promise<ParsedCommit[]> {
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const args = [
    'log',
    `--format=%H${FIELD_SEP}%at${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`,
    '--name-status',
    '-z',
    `--max-count=${limit}`,
  ];
  if (opts.since) args.push(`--since=${opts.since}`);

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.rootPath });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => stdout.push(b));
    child.stderr.on('data', (b: Buffer) => stderr.push(b));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        const msg = Buffer.concat(stderr).toString('utf-8').trim()
          || `git exited with code ${code}`;
        reject(new Error(msg));
        return;
      }
      try {
        resolve(parseGitLog(Buffer.concat(stdout).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    });
  });
}
