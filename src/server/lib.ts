import { customAlphabet } from 'nanoid';
import path from 'node:path';
import os from 'node:os';

const slugAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
const slugSuffix = customAlphabet(slugAlphabet, 4);

const idAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
const sessionId = customAlphabet(idAlphabet, 12);

/** Generate a slug from a name (kebab-case, ascii-safe with hash suffix for non-ascii) */
export function makeSlug(name: string, takenSlugs: Set<string> = new Set()): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  // If the slug ends up empty (all non-ascii) or has Korean, add a random suffix
  const hasKorean = /[가-힣]/.test(base);
  const safeBase = hasKorean || !base ? slugSuffix() : base;

  let candidate = safeBase;
  let n = 2;
  while (takenSlugs.has(candidate)) {
    candidate = `${safeBase}-${n++}`;
  }
  return candidate;
}

export function newSessionId(): string {
  return sessionId();
}

/** Format an ADR ID — ADR-0001, ADR-0002, etc. */
export function formatAdrId(n: number): string {
  return `ADR-${String(n).padStart(4, '0')}`;
}

export function now(): number {
  return Date.now();
}

/** Default DB location: ~/.vibemate/db.sqlite */
export function defaultDbPath(): string {
  return path.join(os.homedir(), '.vibemate', 'db.sqlite');
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), '.vibemate');
}

/** Format a unix timestamp as a human-readable Korean relative time. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diffMs = now - ts;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return '방금';
  if (diffMin < 60) return `${diffMin}분 전`;
  if (diffHour < 24 && new Date(ts).getDate() === new Date(now).getDate()) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `오늘 ${hh}:${mm}`;
  }
  if (diffDay === 1) return '어제';
  if (diffDay < 7) return `${diffDay}일 전`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}주 전`;
  return `${Math.floor(diffDay / 30)}달 전`;
}

/** Filter out files that should never be tracked (build artifacts, deps, etc.) */
const IGNORE_PATTERNS = [
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)target\//,
  /(^|\/)\.cache\//,
  /(^|\/)\.vibemate\//,
  /\.lock$/,
  /\.log$/,
  /\.pyc$/,
  /\.DS_Store$/,
];

export function shouldIgnoreFile(filePath: string): boolean {
  return IGNORE_PATTERNS.some((re) => re.test(filePath));
}

/** Resolve a file path relative to a project root. Returns null if outside the root. */
export function relativizeToProject(filePath: string, projectRoot: string): string | null {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}
