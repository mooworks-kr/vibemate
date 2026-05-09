// Search latency + quality benchmark.
//
// Builds a synthetic vibemate DB (50 features / 30 decisions / 100 sessions /
// 200 file_explanations) seeded with Korean-heavy content, then exercises 20
// representative queries across four token shapes (word-start / mid-word /
// mixed / short). Reports per-query p50/p95 latency, hit count, and the
// search_fts on-disk footprint.
//
// Run:   npx tsx scripts/measure-search.ts
//
// The output is structured for direct comparison: rerun with a different
// tokenizer / weight configuration and diff the tables. Used as the baseline
// for the trigram tokenizer evaluation (feature bi03).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDb, getDb } from '../src/server/db.js';
import * as domain from '../src/server/domain.js';

// ============================================================
// Synthetic data pools — combinatorial generators sized to hit our targets.
// Mostly Korean with a sprinkle of Latin identifiers so the dataset behaves
// like a real-world Korean SaaS codebase rather than a single-language toy.
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

// ============================================================
// Seed function
// ============================================================

function seed(): { projectId: string; tmpDir: string; dbPath: string } {
  closeDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-perf-'));
  const dbPath = path.join(tmpDir, 'db.sqlite');
  getDb(dbPath); // primes singleton + runs migrations

  const project = domain.createProject({ name: '벤치마크 프로젝트', rootPath: tmpDir });

  // 50 features
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

  // 30 decisions
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

  // 100 sessions — written directly (createSession isn't a domain primitive).
  // We need realistic summaries because that's the FTS body. Just use raw
  // INSERTs; FTS triggers will pick them up.
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

  // 200 file_explanations
  for (let i = 0; i < 200; i++) {
    const dom = FILE_DOMAINS[i % FILE_DOMAINS.length]!;
    const kind = FILE_KINDS[i % FILE_KINDS.length]!;
    const filePath = `src/${dom}/${kind}-${i}.ts`;
    // Write the file so saveFileExplanation can read+hash it.
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
// Query catalog — 20 queries × 4 categories × 5 each
// ============================================================

interface Query {
  q: string;
  category: 'word-start' | 'mid-word' | 'mixed' | 'short';
}

const QUERIES: Query[] = [
  // word-start: existing tokenizer + prefix * should hit cleanly.
  { q: '인증', category: 'word-start' },
  { q: '결제', category: 'word-start' },
  { q: '알림', category: 'word-start' },
  { q: '검색', category: 'word-start' },
  { q: '프로필', category: 'word-start' },

  // mid-word: substring inside a Korean 어절. unicode61 + prefix can't match
  // these; trigram should.
  { q: '증을', category: 'mid-word' },
  { q: '제를', category: 'mid-word' },
  { q: '림이', category: 'mid-word' },
  { q: '색을', category: 'mid-word' },
  { q: '필링', category: 'mid-word' },

  // mixed: multi-word queries that AND across the index.
  { q: '인증 모듈', category: 'mixed' },
  { q: '결제 흐름', category: 'mixed' },
  { q: '검색 강화', category: 'mixed' },
  { q: '추천 알고리즘', category: 'mixed' },
  { q: '에러 리포팅', category: 'mixed' },

  // short: single hangul syllable. Big result sets — stresses ranking.
  { q: '인', category: 'short' },
  { q: '결', category: 'short' },
  { q: '알', category: 'short' },
  { q: '검', category: 'short' },
  { q: '프', category: 'short' },
];

// ============================================================
// Latency measurement
// ============================================================

interface QueryResult {
  query: string;
  category: string;
  hits: number;
  p50_ms: number;
  p95_ms: number;
  topTitles: string[];
}

const RUNS_PER_QUERY = 50;
const WARMUP_RUNS = 3;

function measure(projectId: string, query: Query): QueryResult {
  // Warmup so JIT/page cache effects don't bleed into the first sample.
  for (let i = 0; i < WARMUP_RUNS; i++) domain.searchProject(projectId, query.q);

  const samples: number[] = [];
  let lastResults: domain.SearchResult[] = [];
  for (let i = 0; i < RUNS_PER_QUERY; i++) {
    const t0 = performance.now();
    lastResults = domain.searchProject(projectId, query.q);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);

  return {
    query: query.q,
    category: query.category,
    hits: lastResults.length,
    p50_ms: samples[Math.floor(samples.length * 0.5)] ?? 0,
    p95_ms: samples[Math.floor(samples.length * 0.95)] ?? 0,
    // Top 3 titles for ranking spot-check. Strip <mark> tags so output is clean.
    topTitles: lastResults.slice(0, 3).map((r) => r.title.replace(/<\/?mark>/g, '')),
  };
}

// ============================================================
// Index size
// ============================================================

function indexSize(dbPath: string): { totalBytes: number; ftsBytes: number | null } {
  const totalBytes = fs.statSync(dbPath).size;
  // dbstat is a virtual table that exposes per-name page usage. It needs to
  // be enabled at SQLite compile time — node's bundled SQLite usually has it.
  // If unavailable, return null and let the caller report just totalBytes.
  let ftsBytes: number | null = null;
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'search_fts%'")
      .get() as { bytes: number | null };
    ftsBytes = row.bytes ?? 0;
  } catch {
    // dbstat not compiled in — totalBytes is the only signal we get.
  }
  return { totalBytes, ftsBytes };
}

// ============================================================
// Output
// ============================================================

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function printReport(results: QueryResult[], size: ReturnType<typeof indexSize>): void {
  console.log('# Search Benchmark — baseline (unicode61 + prefix \\*)');
  console.log('');
  console.log(`Dataset: 50 features / 30 decisions / 100 sessions / 200 file_explanations`);
  console.log(`Runs per query: ${RUNS_PER_QUERY} (warmup ${WARMUP_RUNS})`);
  console.log('');
  console.log('## Index footprint');
  console.log('');
  console.log(`- DB file total: ${fmtBytes(size.totalBytes)}`);
  if (size.ftsBytes !== null) {
    console.log(`- search_fts pages: ${fmtBytes(size.ftsBytes)}`);
  } else {
    console.log('- search_fts pages: dbstat unavailable');
  }
  console.log('');
  console.log('## Per-query');
  console.log('');
  console.log('| category | query | hits | p50 (ms) | p95 (ms) | top match |');
  console.log('|---|---|---:|---:|---:|---|');
  for (const r of results) {
    const top = r.topTitles[0] ?? '(none)';
    console.log(
      `| ${r.category} | \`${r.query}\` | ${r.hits} | ${r.p50_ms.toFixed(2)} | ${r.p95_ms.toFixed(2)} | ${top} |`,
    );
  }
  console.log('');

  // Per-category roll-up so trigram comparison is easy at a glance.
  const byCategory = new Map<string, { p50sum: number; p95sum: number; hitsSum: number; n: number }>();
  for (const r of results) {
    const acc = byCategory.get(r.category) ?? { p50sum: 0, p95sum: 0, hitsSum: 0, n: 0 };
    acc.p50sum += r.p50_ms;
    acc.p95sum += r.p95_ms;
    acc.hitsSum += r.hits;
    acc.n += 1;
    byCategory.set(r.category, acc);
  }
  console.log('## Per-category averages');
  console.log('');
  console.log('| category | avg p50 (ms) | avg p95 (ms) | avg hits |');
  console.log('|---|---:|---:|---:|');
  for (const [cat, acc] of byCategory) {
    console.log(
      `| ${cat} | ${(acc.p50sum / acc.n).toFixed(2)} | ${(acc.p95sum / acc.n).toFixed(2)} | ${(acc.hitsSum / acc.n).toFixed(1)} |`,
    );
  }
}

// ============================================================
// Main
// ============================================================

function main(): void {
  const seeded = seed();
  try {
    const results = QUERIES.map((q) => measure(seeded.projectId, q));
    const size = indexSize(seeded.dbPath);
    printReport(results, size);
  } finally {
    closeDb();
    fs.rmSync(seeded.tmpDir, { recursive: true, force: true });
  }
}

main();
