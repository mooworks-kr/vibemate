// Trigram tokenizer vs current (unicode61 + prefix *) head-to-head benchmark.
//
// Builds a single temp DB, seeds the same synthetic corpus as
// `measure-search.ts`, then provisions a side-by-side `search_fts_trigram`
// virtual table backfilled from the same source rows. Runs the identical
// 20 queries on both indexes and reports a comparison table.
//
// Run:   npx tsx scripts/compare-trigram.ts
//
// What we report per index:
//   * latency p50/p95
//   * hit count
//   * which mid-word queries actually return rows (the headline gap from
//     ADR-0005 — unicode61 + prefix * can't match inside Korean 어절)
//   * "intended" precision: hits that have the literal query as a substring
//     vs spurious hits matched only via incidental trigram overlap
//   * index pages on disk (dbstat) for size comparison

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDb, getDb } from '../src/server/db.js';
import * as domain from '../src/server/domain.js';

// ============================================================
// Same synthetic data pools as measure-search.ts. Duplicated rather than
// imported so both scripts stay self-contained for easy archiving alongside
// their reports.
// ============================================================

const FEATURE_DOMAINS = [
  '사용자 인증', '결제', '알림', '검색', '프로필', '장바구니', '주문', '리뷰',
  '쿠폰', '회원가입', '비밀번호 재설정', '이메일 인증', 'SNS 로그인',
  '다크 모드', '푸시 알림', '필터링', '추천 알고리즘', '환불', '배송 추적',
  '재고 관리', '카테고리 트리', '태그 관리', '즐겨찾기', '위시리스트',
  '오프라인 모드', '다국어 지원', '접근성', '성능 모니터링', '에러 리포팅',
  '캐시 전략',
];

const FEATURE_SUFFIXES = ['모듈', '시스템', '흐름', '관리', '처리', '강화', '개선', '구현', '리팩토링', '최적화'];

const DECISION_VERBS = ['채택', '도입', '폐기', '연기', '전환', '대체', '단순화'];
const DECISION_TARGETS = [
  'OAuth2 + PKCE', 'JWT 토큰 만료 정책', 'Redis 캐시', 'PostgreSQL → SQLite',
  'TanStack Query', 'GraphQL 검토', 'WebSocket 실시간', 'CDN 정적 자산',
  'CI/CD 파이프라인', 'monorepo 구조', '테스트 전략', '릴리스 주기',
  'on-call 로테이션', '에러 추적 도구', '로깅 포맷', 'API 율 제한',
];

const SESSION_TEMPLATES = [
  '{domain} {action}',
  '{domain} 관련 {action}',
  '{domain} 디버깅 + {action}',
  '{domain} 코드리뷰 후 {action}',
];
const SESSION_ACTIONS = ['초기 구현', '기본 골격', '테스트 추가', '리팩토링', '버그 수정', '성능 개선', '문서 정리', '리뷰 반영', 'PR 머지'];

const FILE_DOMAINS = ['auth', 'billing', 'notify', 'search', 'profile', 'cart', 'order', 'review', 'coupon', 'admin'];
const FILE_KINDS = ['service', 'controller', 'repo', 'model', 'util', 'view', 'queue', 'worker', 'config', 'mock'];

function seed(): { projectId: string; tmpDir: string; dbPath: string } {
  closeDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-cmp-'));
  const dbPath = path.join(tmpDir, 'db.sqlite');
  getDb(dbPath);

  const project = domain.createProject({ name: '벤치마크 프로젝트', rootPath: tmpDir });

  for (let i = 0; i < 50; i++) {
    const dom = FEATURE_DOMAINS[i % FEATURE_DOMAINS.length]!;
    const suf = FEATURE_SUFFIXES[i % FEATURE_SUFFIXES.length]!;
    domain.createFeature({
      projectId: project.id,
      name: `${dom} ${suf}`,
      goal: `${dom} ${suf}을 안정화하고 사용자 경험을 개선한다.`,
      spec_md: `# ${dom} ${suf}\n\n## 목적\n${dom} 도메인의 핵심 기능 ${suf}.\n\n## 범위\n- 정상 흐름\n- 에러 처리\n- 모니터링`,
    });
  }

  for (let i = 0; i < 30; i++) {
    const verb = DECISION_VERBS[i % DECISION_VERBS.length]!;
    const target = DECISION_TARGETS[i % DECISION_TARGETS.length]!;
    domain.logDecision({
      projectId: project.id,
      title: `${target} ${verb}`,
      context: `${target} 도입 검토. 현재 구조에서 ${target}이 어떤 역할을 할지 평가.`,
      decision: `${target}을 ${verb}하기로 함. 주요 이유는 운영 단순성과 비용 효율.`,
      alternatives: '직접 구현 / 외부 서비스 / 기존 도구 확장',
      consequences: '단기적으로 학습 곡선 + 인프라 변경. 장기적으로 운영 부담 감소.',
    });
  }

  const db = getDb();
  const features = domain.listFeatures(project.id);
  const insertSession = db.prepare(
    'INSERT INTO sessions (id, project_id, feature_id, started_at, summary, notes) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 100; i++) {
    const tmpl = SESSION_TEMPLATES[i % SESSION_TEMPLATES.length]!;
    const dom = FEATURE_DOMAINS[i % FEATURE_DOMAINS.length]!;
    const action = SESSION_ACTIONS[i % SESSION_ACTIONS.length]!;
    const summary = tmpl.replace('{domain}', dom).replace('{action}', action);
    const notes = `세션 ${i}: ${dom} 영역에서 ${action} 완료. 다음 세션에 후속 작업.`;
    const featureId = features[i % features.length]!.id;
    insertSession.run(
      `s-${i.toString(36).padStart(6, '0')}`,
      project.id,
      featureId,
      Date.now() - i * 3600_000,
      summary,
      notes,
    );
  }

  for (let i = 0; i < 200; i++) {
    const dom = FILE_DOMAINS[i % FILE_DOMAINS.length]!;
    const kind = FILE_KINDS[i % FILE_KINDS.length]!;
    const filePath = `src/${dom}/${kind}-${i}.ts`;
    const abs = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `// ${dom}/${kind} #${i}\nexport const id = ${i};\n`);
    const featureDom = FEATURE_DOMAINS[i % FEATURE_DOMAINS.length]!;
    const explanation = `${featureDom} 도메인의 ${kind} 레이어. ${dom}/${kind}-${i} 파일은 ${featureDom} 흐름에서 사용된다. 주요 책임은 입출력 매핑과 부수 효과 차단.`;
    domain.saveFileExplanation(project.id, filePath, explanation);
  }

  return { projectId: project.id, tmpDir, dbPath };
}

// ============================================================
// Trigram side-table provisioning
// ============================================================

/**
 * Create a parallel `search_fts_trigram` virtual table with the trigram
 * tokenizer and copy every row from `search_fts` into it. The original
 * unicode61 index stays untouched so both can be queried side-by-side.
 *
 * Returns false when the SQLite build doesn't ship the trigram tokenizer
 * (older builds; Node's bundled SQLite has it on 22.5+, but defensive).
 */
function buildTrigramIndex(): boolean {
  const db = getDb();
  try {
    db.exec(`
      CREATE VIRTUAL TABLE search_fts_trigram USING fts5(
        title, body, kind UNINDEXED, ref_id UNINDEXED, project_id UNINDEXED,
        tokenize='trigram'
      );
      INSERT INTO search_fts_trigram (kind, ref_id, project_id, title, body)
        SELECT kind, ref_id, project_id, title, body FROM search_fts;
    `);
    return true;
  } catch (err) {
    console.error('trigram tokenizer 미가용:', (err as Error).message);
    return false;
  }
}

// ============================================================
// Query execution — one path per index
// ============================================================

const SNIPPET_OPEN = 'MARK_OPEN';
const SNIPPET_CLOSE = 'MARK_CLOSE';

interface RawHit {
  kind: string;
  ref_id: string;
  title: string;
  body: string;
  score: number;
}

/** Mirror of domain.sanitizeFtsQuery but exposed here so we can also produce
 *  the no-prefix-* variant for trigram. */
function sanitize(raw: string, addPrefix: boolean): string {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => (addPrefix ? `${t}*` : t)).join(' ');
}

/** Run the unicode61 search path with prefix-* (current production). */
function runUnicode61(projectId: string, query: string): RawHit[] {
  const ftsQuery = sanitize(query, /* prefix */ true);
  if (!ftsQuery) return [];
  const db = getDb();
  try {
    return db
      .prepare(
        `SELECT kind, ref_id, title, body, bm25(search_fts) AS score
           FROM search_fts
          WHERE project_id = ? AND search_fts MATCH ?
          ORDER BY score
          LIMIT 50`,
      )
      .all(projectId, ftsQuery) as unknown as RawHit[];
  } catch {
    return [];
  }
}

/** Run the trigram search path. No prefix * — trigram matches via grams. */
function runTrigram(projectId: string, query: string): RawHit[] {
  const ftsQuery = sanitize(query, /* prefix */ false);
  if (!ftsQuery) return [];
  const db = getDb();
  try {
    return db
      .prepare(
        `SELECT kind, ref_id, title, body, bm25(search_fts_trigram) AS score
           FROM search_fts_trigram
          WHERE project_id = ? AND search_fts_trigram MATCH ?
          ORDER BY score
          LIMIT 50`,
      )
      .all(projectId, ftsQuery) as unknown as RawHit[];
  } catch (err) {
    console.error(`trigram query 실패 (${query}):`, (err as Error).message);
    return [];
  }
}

// ============================================================
// Query catalog (same as measure-search.ts)
// ============================================================

interface Query { q: string; category: 'word-start' | 'mid-word' | 'mixed' | 'short' }

const QUERIES: Query[] = [
  { q: '인증', category: 'word-start' },
  { q: '결제', category: 'word-start' },
  { q: '알림', category: 'word-start' },
  { q: '검색', category: 'word-start' },
  { q: '프로필', category: 'word-start' },
  { q: '증을', category: 'mid-word' },
  { q: '제를', category: 'mid-word' },
  { q: '림이', category: 'mid-word' },
  { q: '색을', category: 'mid-word' },
  { q: '필링', category: 'mid-word' },
  { q: '인증 모듈', category: 'mixed' },
  { q: '결제 흐름', category: 'mixed' },
  { q: '검색 강화', category: 'mixed' },
  { q: '추천 알고리즘', category: 'mixed' },
  { q: '에러 리포팅', category: 'mixed' },
  { q: '인', category: 'short' },
  { q: '결', category: 'short' },
  { q: '알', category: 'short' },
  { q: '검', category: 'short' },
  { q: '프', category: 'short' },
];

// ============================================================
// Measurement
// ============================================================

const RUNS = 50;
const WARMUP = 3;

interface MeasureRow {
  hits: number;
  p50: number;
  p95: number;
  intendedHits: number;
}

/**
 * Count "intended" hits — rows whose title or body literally contains every
 * sanitised token in the query as a substring. Anything beyond that count is
 * considered a spurious match (false positive) attributable to the tokenizer.
 *
 * For multi-token queries we require all tokens to match (AND semantics, same
 * as FTS5). For empty token lists (e.g. all-special-chars) we treat every
 * hit as intended — the query was effectively a wildcard.
 */
function countIntended(hits: RawHit[], query: string): number {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return hits.length;
  return hits.filter((h) => {
    const haystack = `${h.title} ${h.body}`;
    return tokens.every((t) => haystack.includes(t));
  }).length;
}

function measure(projectId: string, query: Query, runner: (pid: string, q: string) => RawHit[]): MeasureRow {
  for (let i = 0; i < WARMUP; i++) runner(projectId, query.q);
  const samples: number[] = [];
  let last: RawHit[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    last = runner(projectId, query.q);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    hits: last.length,
    p50: samples[Math.floor(samples.length * 0.5)] ?? 0,
    p95: samples[Math.floor(samples.length * 0.95)] ?? 0,
    intendedHits: countIntended(last, query.q),
  };
}

// ============================================================
// Output
// ============================================================

function fmtBytes(n: number | null): string {
  if (n === null) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function indexPages(table: string): number | null {
  try {
    const db = getDb();
    const row = db
      .prepare(`SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE ?`)
      .get(`${table}%`) as { bytes: number | null };
    return row.bytes ?? 0;
  } catch {
    return null;
  }
}

interface ComparisonRow {
  category: Query['category'];
  query: string;
  u: MeasureRow;
  t: MeasureRow;
}

function printReport(rows: ComparisonRow[]): void {
  console.log('# Trigram vs unicode61+prefix\\* 비교');
  console.log('');
  console.log(`Dataset: 50 features / 30 decisions / 100 sessions / 200 file_explanations`);
  console.log(`Runs per query: ${RUNS} (warmup ${WARMUP})`);
  console.log('');

  // Index footprint
  const u61Bytes = indexPages('search_fts');
  const trgBytes = indexPages('search_fts_trigram');
  console.log('## 인덱스 크기');
  console.log('');
  console.log('| 인덱스 | bytes | 비율 (vs unicode61) |');
  console.log('|---|---:|---:|');
  console.log(`| search_fts (unicode61) | ${fmtBytes(u61Bytes)} | 1.00× |`);
  if (trgBytes !== null && u61Bytes !== null && u61Bytes > 0) {
    console.log(`| search_fts_trigram | ${fmtBytes(trgBytes)} | ${(trgBytes / u61Bytes).toFixed(2)}× |`);
  } else {
    console.log(`| search_fts_trigram | ${fmtBytes(trgBytes)} | — |`);
  }
  console.log('');

  // Per-query comparison
  console.log('## 쿼리별 비교');
  console.log('');
  console.log('| 카테고리 | 쿼리 | u61 hits | trg hits | u61 p95 (ms) | trg p95 (ms) | u61 정밀도 | trg 정밀도 |');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    const u61Prec = r.u.hits > 0 ? `${((r.u.intendedHits / r.u.hits) * 100).toFixed(0)}%` : '—';
    const trgPrec = r.t.hits > 0 ? `${((r.t.intendedHits / r.t.hits) * 100).toFixed(0)}%` : '—';
    console.log(
      `| ${r.category} | \`${r.query}\` | ${r.u.hits} | ${r.t.hits} | ${r.u.p95.toFixed(2)} | ${r.t.p95.toFixed(2)} | ${u61Prec} | ${trgPrec} |`,
    );
  }
  console.log('');

  // Per-category roll-up
  type Acc = { uHits: number; uP95: number; uIntend: number; tHits: number; tP95: number; tIntend: number; n: number };
  const cats = new Map<string, Acc>();
  for (const r of rows) {
    const a = cats.get(r.category) ?? { uHits: 0, uP95: 0, uIntend: 0, tHits: 0, tP95: 0, tIntend: 0, n: 0 };
    a.uHits += r.u.hits; a.uP95 += r.u.p95; a.uIntend += r.u.intendedHits;
    a.tHits += r.t.hits; a.tP95 += r.t.p95; a.tIntend += r.t.intendedHits;
    a.n += 1;
    cats.set(r.category, a);
  }
  console.log('## 카테고리 평균');
  console.log('');
  console.log('| 카테고리 | u61 avg hits | trg avg hits | u61 avg p95 | trg avg p95 | u61 정밀도 | trg 정밀도 |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const [cat, a] of cats) {
    const uPrec = a.uHits > 0 ? `${((a.uIntend / a.uHits) * 100).toFixed(0)}%` : '—';
    const tPrec = a.tHits > 0 ? `${((a.tIntend / a.tHits) * 100).toFixed(0)}%` : '—';
    console.log(
      `| ${cat} | ${(a.uHits / a.n).toFixed(1)} | ${(a.tHits / a.n).toFixed(1)} | ${(a.uP95 / a.n).toFixed(2)} | ${(a.tP95 / a.n).toFixed(2)} | ${uPrec} | ${tPrec} |`,
    );
  }
}

// ============================================================
// Main
// ============================================================

function main(): void {
  const seeded = seed();
  try {
    if (!buildTrigramIndex()) {
      console.error('이 환경에서는 trigram 토크나이저를 쓸 수 없어 비교를 중단합니다.');
      process.exit(2);
    }

    const rows: ComparisonRow[] = QUERIES.map((q) => ({
      category: q.category,
      query: q.q,
      u: measure(seeded.projectId, q, runUnicode61),
      t: measure(seeded.projectId, q, runTrigram),
    }));

    printReport(rows);
  } finally {
    closeDb();
    fs.rmSync(seeded.tmpDir, { recursive: true, force: true });
  }
}

main();
