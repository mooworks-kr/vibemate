// Tasks-in-search hypothesis validation.
//
// ADR-0005 excluded `tasks` from the FTS index for two reasons: short names
// would add noise to results, and there's no stable navigation target for a
// task hit (which feature page do you land on?). With no real-user search
// data this script tests the hypothesis on synthetic data — same shape as
// the trigram comparison, with `tasks` mixed in.
//
// Run:   npx tsx scripts/measure-tasks-search.ts
//
// What we report:
//   * delta hits per query when tasks are included — does it surface useful
//     items the user otherwise misses, or just dilute results?
//   * "noise" floor: how many tasks match very generic 1-2-syllable queries
//     that aren't really about a task ("수정", "추가").
//   * search_fts size growth (tasks add 100 new title rows).
//   * navigation cost: free-form notes about what'd need to change in
//     web/main.ts to land on a task hit.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDb, getDb } from '../src/server/db.js';
import * as domain from '../src/server/domain.js';

// ============================================================
// Synthetic data — same baseline as measure-search.ts plus tasks.
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
const SESSION_TEMPLATES = ['{domain} {action}', '{domain} 관련 {action}', '{domain} 디버깅 + {action}', '{domain} 코드리뷰 후 {action}'];
const SESSION_ACTIONS = ['초기 구현', '기본 골격', '테스트 추가', '리팩토링', '버그 수정', '성능 개선', '문서 정리', '리뷰 반영', 'PR 머지'];
const FILE_DOMAINS = ['auth', 'billing', 'notify', 'search', 'profile', 'cart', 'order', 'review', 'coupon', 'admin'];
const FILE_KINDS = ['service', 'controller', 'repo', 'model', 'util', 'view', 'queue', 'worker', 'config', 'mock'];

// Tasks: realistic Korean PM task names. A mix of:
//   * specific compound names (`사용자 인증 폼 추가`) — the kind we hope users
//     actually want to find by name
//   * short verb-only names (`수정`, `테스트`, `리뷰`) — noise candidates that
//     match generic queries on dozens of unrelated entities
//   * Latin/identifier-ish names (`SQL 쿼리 최적화`) — control group for the
//     hypothesis that English-leaning identifiers behave differently
const TASK_TARGETS = [
  '사용자 인증 폼', '결제 콜백 핸들러', '알림 토글 UI', '검색 필터 칩',
  '프로필 이미지 업로드', '장바구니 항목 정렬', '주문 상세 페이지',
  '리뷰 평점 표시', '쿠폰 코드 입력', '회원가입 약관 동의',
  '비밀번호 강도 인디케이터', '이메일 템플릿', 'SNS 콜백 라우트',
  '다크 모드 토글', '푸시 토큰 등록', 'SQL 쿼리', 'API 율 제한',
  '캐시 키 디자인', '에러 리포터 통합', '로그 파이프라인',
];
const TASK_ACTIONS = ['추가', '수정', '리팩토링', '디버깅', '테스트', '리뷰', '문서화', '최적화'];
const TASK_NOISE_NAMES = ['수정', '테스트', '리뷰', '추가', '배포', '리팩토링', '문서화'];

function seed(): { projectId: string; tmpDir: string; dbPath: string } {
  closeDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-tasks-'));
  const dbPath = path.join(tmpDir, 'db.sqlite');
  getDb(dbPath);

  const project = domain.createProject({ name: '벤치마크', rootPath: tmpDir });

  for (let i = 0; i < 50; i++) {
    const dom = FEATURE_DOMAINS[i % FEATURE_DOMAINS.length]!;
    const suf = FEATURE_SUFFIXES[i % FEATURE_SUFFIXES.length]!;
    domain.createFeature({
      projectId: project.id,
      name: `${dom} ${suf}`,
      goal: `${dom} ${suf}을 안정화하고 사용자 경험을 개선한다.`,
      spec_md: `# ${dom} ${suf}\n\n## 목적\n${dom} 도메인의 핵심 기능 ${suf}.`,
    });
  }
  for (let i = 0; i < 30; i++) {
    const verb = DECISION_VERBS[i % DECISION_VERBS.length]!;
    const target = DECISION_TARGETS[i % DECISION_TARGETS.length]!;
    domain.logDecision({
      projectId: project.id,
      title: `${target} ${verb}`,
      context: `${target} 도입 검토.`,
      decision: `${target}을 ${verb}하기로 함.`,
    });
  }

  const features = domain.listFeatures(project.id);
  const db = getDb();
  const insertSession = db.prepare(
    'INSERT INTO sessions (id, project_id, feature_id, started_at, summary, notes) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 100; i++) {
    const tmpl = SESSION_TEMPLATES[i % SESSION_TEMPLATES.length]!;
    const dom = FEATURE_DOMAINS[i % FEATURE_DOMAINS.length]!;
    const action = SESSION_ACTIONS[i % SESSION_ACTIONS.length]!;
    const summary = tmpl.replace('{domain}', dom).replace('{action}', action);
    const notes = `세션 ${i}: ${dom} 영역에서 ${action} 완료.`;
    insertSession.run(
      `s-${i.toString(36).padStart(6, '0')}`,
      project.id,
      features[i % features.length]!.id,
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
    const explanation = `${featureDom} 도메인의 ${kind} 레이어. ${dom}/${kind}-${i} 파일은 ${featureDom} 흐름에서 사용된다.`;
    domain.saveFileExplanation(project.id, filePath, explanation);
  }

  // 100 tasks: 80 specific + 20 noise (verb-only short names) so noise effects
  // are measurable without dominating.
  for (let i = 0; i < 80; i++) {
    const target = TASK_TARGETS[i % TASK_TARGETS.length]!;
    const action = TASK_ACTIONS[i % TASK_ACTIONS.length]!;
    const featureId = features[i % features.length]!.id;
    domain.addTask(featureId, `${target} ${action}`);
  }
  for (let i = 0; i < 20; i++) {
    const featureId = features[i % features.length]!.id;
    domain.addTask(featureId, TASK_NOISE_NAMES[i % TASK_NOISE_NAMES.length]!);
  }

  return { projectId: project.id, tmpDir, dbPath };
}

// ============================================================
// Side-table: search_fts_with_tasks. Mirrors search_fts plus a 'task' kind.
// Trigger-style write parity not needed for this measurement — we just need
// a snapshot index to query against.
// ============================================================

function buildIndexWithTasks(projectId: string): void {
  const db = getDb();
  db.exec(`
    CREATE VIRTUAL TABLE search_fts_with_tasks USING fts5(
      title, body, kind UNINDEXED, ref_id UNINDEXED, project_id UNINDEXED
    );
    INSERT INTO search_fts_with_tasks (kind, ref_id, project_id, title, body)
      SELECT kind, ref_id, project_id, title, body FROM search_fts;
  `);
  // Tasks: title=name, body='' (notes are usually empty in practice). Hypothesis
  // is that body emptiness is itself part of the noise problem.
  const tasks = db
    .prepare(
      `SELECT t.id AS id, t.name AS name, COALESCE(t.notes, '') AS notes
         FROM tasks t JOIN features f ON f.id = t.feature_id
        WHERE f.project_id = ?`,
    )
    .all(projectId) as Array<{ id: number; name: string; notes: string }>;
  const insert = db.prepare(
    `INSERT INTO search_fts_with_tasks (kind, ref_id, project_id, title, body) VALUES ('task', ?, ?, ?, ?)`,
  );
  for (const t of tasks) {
    insert.run(String(t.id), projectId, t.name, t.notes);
  }
}

// ============================================================
// Query paths
// ============================================================

interface RawHit {
  kind: string;
  ref_id: string;
  title: string;
  body: string;
  score: number;
}

function sanitizePrefix(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 0);
  return tokens.length === 0 ? '' : tokens.map((t) => `${t}*`).join(' ');
}

function runOn(table: 'search_fts' | 'search_fts_with_tasks', projectId: string, query: string): RawHit[] {
  const ftsQuery = sanitizePrefix(query);
  if (!ftsQuery) return [];
  const db = getDb();
  try {
    return db
      .prepare(
        `SELECT kind, ref_id, title, body, bm25(${table}) AS score
           FROM ${table}
          WHERE project_id = ? AND ${table} MATCH ?
          ORDER BY score
          LIMIT 50`,
      )
      .all(projectId, ftsQuery) as unknown as RawHit[];
  } catch {
    return [];
  }
}

// ============================================================
// Query catalog. Reuse base 20 + add 5 noise probes (generic short verbs that
// only tasks would surface — measures noise floor directly).
// ============================================================

interface Query { q: string; category: 'word-start' | 'mid-word' | 'mixed' | 'short' | 'noise-probe' }

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
  // Noise probes: generic action verbs. These should match dozens of tasks
  // without surfacing the user's actual intent. Quantifies the noise problem.
  { q: '수정', category: 'noise-probe' },
  { q: '테스트', category: 'noise-probe' },
  { q: '리뷰', category: 'noise-probe' },
  { q: '추가', category: 'noise-probe' },
  { q: '리팩토링', category: 'noise-probe' },
];

const RUNS = 30;
const WARMUP = 3;

interface MeasureRow {
  hits: number;
  taskHits: number;        // hits with kind='task'
  nonTaskHits: number;     // hits with kind!='task'
  p95: number;
  topTitles: string[];
}

function measure(projectId: string, table: 'search_fts' | 'search_fts_with_tasks', q: Query): MeasureRow {
  for (let i = 0; i < WARMUP; i++) runOn(table, projectId, q.q);
  const samples: number[] = [];
  let last: RawHit[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    last = runOn(table, projectId, q.q);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    hits: last.length,
    taskHits: last.filter((h) => h.kind === 'task').length,
    nonTaskHits: last.filter((h) => h.kind !== 'task').length,
    p95: samples[Math.floor(samples.length * 0.95)] ?? 0,
    topTitles: last.slice(0, 3).map((h) => h.title),
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

function printReport(rows: Array<{ q: Query; base: MeasureRow; ext: MeasureRow }>): void {
  console.log('# tasks-in-search 가설 검증');
  console.log('');
  console.log(`Dataset: 50 features / 30 decisions / 100 sessions / 200 file_explanations / **100 tasks** (80 specific + 20 noise)`);
  console.log(`Runs per query: ${RUNS} (warmup ${WARMUP})`);
  console.log('');

  const baseSize = indexPages('search_fts');
  const extSize = indexPages('search_fts_with_tasks');
  console.log('## 인덱스 크기');
  console.log('');
  console.log('| 인덱스 | bytes | 비율 |');
  console.log('|---|---:|---:|');
  console.log(`| search_fts (현재 — tasks 제외) | ${fmtBytes(baseSize)} | 1.00× |`);
  if (extSize !== null && baseSize !== null && baseSize > 0) {
    console.log(`| search_fts_with_tasks | ${fmtBytes(extSize)} | ${(extSize / baseSize).toFixed(2)}× |`);
  }
  console.log('');

  console.log('## 쿼리별 비교');
  console.log('');
  console.log('| 카테고리 | 쿼리 | 현재 hits | tasks포함 hits | 신규 task hits | non-task delta |');
  console.log('|---|---|---:|---:|---:|---:|');
  for (const { q, base, ext } of rows) {
    const nonTaskDelta = ext.nonTaskHits - base.hits;
    console.log(
      `| ${q.category} | \`${q.q}\` | ${base.hits} | ${ext.hits} | ${ext.taskHits} | ${nonTaskDelta >= 0 ? '+' : ''}${nonTaskDelta} |`,
    );
  }
  console.log('');

  // Per-category roll-up
  type Acc = { baseHits: number; extHits: number; taskHits: number; n: number };
  const cats = new Map<string, Acc>();
  for (const { q, base, ext } of rows) {
    const a = cats.get(q.category) ?? { baseHits: 0, extHits: 0, taskHits: 0, n: 0 };
    a.baseHits += base.hits; a.extHits += ext.hits; a.taskHits += ext.taskHits; a.n += 1;
    cats.set(q.category, a);
  }
  console.log('## 카테고리 평균');
  console.log('');
  console.log('| 카테고리 | 현재 avg hits | tasks포함 avg hits | task hits 평균 비중 |');
  console.log('|---|---:|---:|---:|');
  for (const [cat, a] of cats) {
    const taskRatio = a.extHits > 0 ? `${((a.taskHits / a.extHits) * 100).toFixed(0)}%` : '—';
    console.log(`| ${cat} | ${(a.baseHits / a.n).toFixed(1)} | ${(a.extHits / a.n).toFixed(1)} | ${taskRatio} |`);
  }
  console.log('');

  // Noise probe details — print top task names matching each generic verb
  console.log('## Noise probe 상세');
  console.log('');
  console.log('| 쿼리 | task hits | top task 매치 |');
  console.log('|---|---:|---|');
  for (const { q, ext } of rows.filter((r) => r.q.category === 'noise-probe')) {
    console.log(`| \`${q.q}\` | ${ext.taskHits} | ${ext.topTitles.slice(0, 3).join(', ') || '(none)'} |`);
  }
}

// ============================================================
// Main
// ============================================================

function main(): void {
  const seeded = seed();
  try {
    buildIndexWithTasks(seeded.projectId);
    const rows = QUERIES.map((q) => ({
      q,
      base: measure(seeded.projectId, 'search_fts', q),
      ext: measure(seeded.projectId, 'search_fts_with_tasks', q),
    }));
    printReport(rows);
  } finally {
    closeDb();
    fs.rmSync(seeded.tmpDir, { recursive: true, force: true });
  }
}

main();
