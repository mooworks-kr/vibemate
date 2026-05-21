#!/usr/bin/env node
import { Command } from 'commander';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import * as domain from './domain.js';
import { getDb } from './db.js';
import {
  startDaemon,
  stopDaemon,
  daemonStatus,
  daemonStartedAtMs,
  buildMtimeMs,
  classifyStaleness,
  PID_FILE,
} from './daemon.js';
import { startMcpServer } from './mcp.js';
import { loadConfig, saveConfig, getConfigPath } from './config.js';

const program = new Command();
program
  .name('pm')
  .description('Vibemate — 바이브 코딩 프로젝트 매니저')
  .version('0.1.0');

// ----------------------------------------------------------------
// pm init [--name X] [--goal Y]
// Register the current directory as a project
// ----------------------------------------------------------------
program
  .command('init')
  .description('현재 디렉토리를 Vibemate 프로젝트로 등록')
  .option('-n, --name <name>', '프로젝트 이름 (기본: 디렉토리 이름)')
  .option('-g, --goal <goal>', '프로젝트 목표')
  .option('-t, --tagline <tagline>', '한 줄 설명')
  .action((opts) => {
    getDb();
    const cwd = process.cwd();
    const existing = domain.getProjectByRoot(cwd);
    if (existing) {
      console.log(`이미 등록된 프로젝트입니다: ${existing.name} (${existing.id})`);
      return;
    }
    const name = opts.name ?? path.basename(cwd);
    const project = domain.createProject({
      name,
      rootPath: cwd,
      tagline: opts.tagline,
      goal: opts.goal,
    });

    // Drop a CLAUDE.md hint if there isn't one already
    writeClaudeMdHint(cwd, project.id);

    console.log(`✓ 프로젝트 등록 완료: ${project.name} (${project.id})`);
    console.log(`  경로: ${cwd}`);
    console.log('');
    console.log('다음 단계:');
    console.log('  1. pm start              # 데몬 + 대시보드 시작');
    console.log('  2. Claude Code의 mcp 설정에 vibemate 서버 추가 (README 참고)');
    console.log('  3. 첫 기능 추가:    pm feature add "내 첫 기능"');
  });

// ----------------------------------------------------------------
// pm start | stop | restart | status
// ----------------------------------------------------------------
// `YYYY-MM-DD HH:mm` formatter used by `pm status` to print daemon start
// time / build mtime. Locale-independent (so test output / log output is
// reproducible across machines) and minute-resolution since the staleness
// hazard plays out over hours-to-days, not seconds.
function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    '-',
    pad(d.getMonth() + 1),
    '-',
    pad(d.getDate()),
    ' ',
    pad(d.getHours()),
    ':',
    pad(d.getMinutes()),
  ].join('');
}

program
  .command('start')
  .description('데몬 시작 (HTTP 서버)')
  .option('-p, --port <port>', '포트', '7321')
  .action(async (opts) => {
    getDb();
    // Sprint 29 (mh48): if a daemon is already running and the build is
    // newer than the daemon, surface the stale hint here too. startDaemon()
    // itself just logs "already running" and returns — without the extra
    // line the user has no signal that they're still on the old binary.
    const existing = daemonStatus();
    if (existing.running) {
      const verdict = classifyStaleness({
        daemonStartedAt: daemonStartedAtMs(),
        buildMtime: buildMtimeMs(),
      });
      if (verdict === 'stale') {
        console.log('⚠ 옛 빌드를 실행 중. `pm restart` 로 새 빌드를 적용하세요.');
      }
    }
    const port = parseInt(opts.port, 10);
    await startDaemon(port);
    console.log(`대시보드: http://localhost:${port}`);
  });

program
  .command('stop')
  .description('데몬 종료')
  .action(() => {
    stopDaemon();
  });

// Sprint 29 (mh48): `pm restart` — `stop` then `start` in one shot. Waits
// for the previous daemon's SIGTERM cleanup to (a) remove the PID file
// AND (b) actually exit the process so the OS releases the bound port. If
// we skipped (b) we'd race into EADDRINUSE because cleanup() unlinks the
// PID before `process.exit()` closes the socket. Same long-running
// semantics as `pm start` — this process becomes the new daemon.
program
  .command('restart')
  .description('데몬 재시작 (stop + start)')
  .option('-p, --port <port>', '포트', '7321')
  .action(async (opts) => {
    getDb();
    // Capture the previous PID *before* sending SIGTERM so we can verify
    // it actually exits, even after the PID file is gone.
    const prevPid = fs.existsSync(PID_FILE)
      ? Number(fs.readFileSync(PID_FILE, 'utf-8')) || null
      : null;
    stopDaemon();

    // Two-phase wait: PID file vanishes (cleanup handler ran), then the
    // old process is actually gone (port released). Cap at ~3s.
    const deadline = Date.now() + 3000;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    while (fs.existsSync(PID_FILE) && Date.now() < deadline) {
      await sleep(50);
    }
    if (prevPid != null) {
      while (Date.now() < deadline) {
        try {
          process.kill(prevPid, 0);
          await sleep(50);
        } catch {
          break; // process gone — port should be free imminently
        }
      }
      // Tiny grace pause so the kernel releases the TCP listening socket
      // before we bind. Empirically <50ms on macOS / Linux.
      await sleep(100);
    }

    const port = parseInt(opts.port, 10);
    await startDaemon(port);
    console.log(`대시보드: http://localhost:${port}`);
  });

program
  .command('status')
  .description('데몬 상태 확인 (stale 빌드 감지 포함)')
  .action(() => {
    const s = daemonStatus();
    if (!s.running) {
      console.log('✗ 실행 중이 아님');
      return;
    }
    console.log(`✓ 실행 중 (pid ${s.pid})`);

    // Sprint 29 (mh48): pair daemon-start mtime with build mtime so users
    // can spot the "data shape changed, daemon still on old code" hazard
    // without grepping logs. classifyStaleness lives in daemon.ts (testable).
    const startedAt = daemonStartedAtMs();
    const buildMs = buildMtimeMs();
    const verdict = classifyStaleness({ daemonStartedAt: startedAt, buildMtime: buildMs });

    if (startedAt != null) console.log(`  기동: ${formatTimestamp(startedAt)}`);
    if (buildMs != null) {
      const tag = verdict === 'stale'
        ? '⚠ stale — `pm restart` 권장'
        : verdict === 'fresh' ? '✓ up-to-date' : '';
      console.log(`  빌드: ${formatTimestamp(buildMs)}${tag ? '  ' + tag : ''}`);
    } else {
      // Dev mode (tsx watch handles reloads itself) — say so explicitly so
      // users don't read the absence as "missing data".
      console.log('  빌드: (dist 없음 — dev 모드 / pm dev)');
    }
  });

program
  .command('dashboard')
  .description('브라우저에서 대시보드 열기')
  .option('-p, --port <port>', '포트', '7321')
  .action((opts) => {
    const url = `http://localhost:${opts.port}`;
    const cmd =
      process.platform === 'darwin' ? `open ${url}` :
      process.platform === 'win32' ? `start ${url}` :
      `xdg-open ${url}`;
    exec(cmd);
  });

// ----------------------------------------------------------------
// pm mcp -- start the MCP server (called by Claude Code)
// ----------------------------------------------------------------
program
  .command('mcp')
  .description('MCP 서버 시작 (Claude Code가 호출)')
  .option('--project <id>', '명시적 프로젝트 ID')
  .action(async (opts) => {
    getDb();
    await startMcpServer({ projectId: opts.project });
  });

// ----------------------------------------------------------------
// pm feature ...
// ----------------------------------------------------------------
const featureCmd = program.command('feature').description('기능 관리');

featureCmd
  .command('add <name>')
  .description('새 기능 추가')
  .option('-g, --goal <goal>', '한 줄 목표')
  .action((name, opts) => {
    getDb();
    const project = currentProject();
    const f = domain.createFeature({ projectId: project.id, name, goal: opts.goal });
    console.log(`✓ 기능 추가: ${f.name} (${f.id})`);
  });

featureCmd
  .command('list')
  .description('기능 목록')
  .action(() => {
    getDb();
    const project = currentProject();
    const features = domain.listFeatures(project.id);
    if (features.length === 0) {
      console.log('등록된 기능이 없습니다. pm feature add "이름" 으로 추가하세요.');
      return;
    }
    console.log(`프로젝트: ${project.name}`);
    console.log('');
    for (const f of features) {
      const { progress, done, total } = domain.getFeatureProgress(f.id);
      const statusIcon = f.status === 'done' ? '✓' : f.status === 'in_progress' ? '◐' : '○';
      const progressStr = total > 0 ? ` [${done}/${total} · ${progress}%]` : '';
      console.log(`  ${statusIcon} ${f.name}${progressStr}`);
      if (f.goal) console.log(`     ${f.goal}`);
    }
  });

// ----------------------------------------------------------------
// pm token | pm server — daemon-side auth + bind. Manage
// ~/.vibemate/config.json. None of these touch the DB.
// ----------------------------------------------------------------

const tokenCmd = program.command('token').description('인증 토큰 관리 (서버 측)');

tokenCmd
  .command('create')
  .description('새 토큰 발급 → config.server.token 저장')
  .action(() => {
    // 32 bytes hex = 64-char string. Plenty of entropy for a single-user
    // Bearer token; we don't need a database row per token in Phase 1.
    const token = crypto.randomBytes(32).toString('hex');
    saveConfig({ server: { token } });
    console.log('✓ 새 토큰을 발급했습니다.');
    console.log(`  ${token}`);
    console.log('');
    console.log('데몬이 실행 중이면 `pm restart` 로 새 토큰을 적용하세요.');
  });

tokenCmd
  .command('show')
  .description('현재 저장된 토큰 출력')
  .action(() => {
    const cfg = loadConfig();
    if (!cfg.server.token) {
      console.log('토큰이 설정되어 있지 않습니다. (인증 비활성)');
      console.log('발급하려면: pm token create');
      return;
    }
    console.log(cfg.server.token);
  });

tokenCmd
  .command('clear')
  .description('토큰 제거 → 인증 비활성')
  .action(() => {
    saveConfig({ server: { token: null } });
    console.log('✓ 토큰을 제거했습니다. (인증 비활성)');
    console.log('데몬이 실행 중이면 `pm restart` 로 적용하세요.');
  });

const serverCmd = program.command('server').description('서버 측 설정');

serverCmd
  .command('bind <host>')
  .description('데몬 bind 주소 변경 (기본 127.0.0.1, 외부 허용은 0.0.0.0)')
  .action((host: string) => {
    saveConfig({ server: { host } });
    console.log(`✓ bind host 를 ${host} 로 변경했습니다.`);
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.log('⚠ loopback 이 아닌 주소입니다. 인증 토큰(`pm token create`) 을 권장합니다.');
    }
    console.log('데몬이 실행 중이면 `pm restart` 로 적용하세요.');
  });

serverCmd
  .command('show')
  .description('현재 서버 설정 출력')
  .action(() => {
    const cfg = loadConfig();
    console.log(`bind:  ${cfg.server.host}`);
    console.log(`token: ${cfg.server.token ? '(설정됨)' : '(없음 — 인증 비활성)'}`);
    console.log(`file:  ${getConfigPath()}`);
  });

// ----------------------------------------------------------------
// pm project ...
// Project-level commands. Today: delete (Sprint 28 / pax6).
// ----------------------------------------------------------------
const projectCmd = program.command('project').description('프로젝트 관리');

projectCmd
  .command('delete <id>')
  .description('프로젝트 삭제 (cascade: features/tasks/sessions/decisions/documents/매핑 자동 삭제)')
  .option('--force', '활성 세션이 있어도 강제 삭제')
  .option('--yes', '대화형 confirm 건너뛰기 (스크립트용)')
  .action(async (id: string, opts: { force?: boolean; yes?: boolean }) => {
    getDb();
    const proj = domain.getProject(id);
    if (!proj) {
      console.error(`× 프로젝트를 찾을 수 없습니다: ${id}`);
      process.exit(1);
      return;
    }

    const impact = domain.getProjectDeletionImpact(id);
    console.log(`프로젝트: ${proj.name} (${proj.id})`);
    console.log(`  경로: ${proj.root_path}`);
    console.log('');
    console.log('함께 삭제될 항목:');
    console.log(`  features:           ${impact.features}`);
    console.log(`  tasks:              ${impact.tasks}`);
    console.log(`  sessions:           ${impact.sessions}`);
    console.log(`  decisions:          ${impact.decisions}`);
    console.log(`  documents:          ${impact.documents}`);
    console.log(`  feature_files:      ${impact.feature_files}`);
    console.log(`  document_features:  ${impact.document_features}`);
    console.log(`  imported_commits:   ${impact.imported_commits}`);
    console.log(`  extracted_features: ${impact.extracted_features}`);
    if (impact.active_sessions > 0) {
      console.log('');
      console.log(`⚠ 활성 세션 ${impact.active_sessions}건이 진행 중입니다.`);
      if (!opts.force) {
        console.log('  먼저 종료하거나 --force 로 강제 삭제하세요.');
      } else {
        console.log('  --force 지정됨: 강제 삭제합니다.');
      }
    }
    console.log('');
    console.log('백업이 필요하면 ~/.vibemate/db.sqlite 를 복사해두세요.');

    if (!opts.yes) {
      const prompt = `\n삭제하려면 프로젝트 이름을 정확히 입력하세요 ("${proj.name}"): `;
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let typed = '';
      try {
        typed = (await rl.question(prompt)).trim();
      } finally {
        rl.close();
      }
      if (typed !== proj.name) {
        console.log('취소했습니다 (이름 불일치).');
        return;
      }
    }

    try {
      const removed = domain.deleteProject(id, { force: opts.force });
      if (!removed) {
        console.error(`× 프로젝트를 찾을 수 없습니다: ${id}`);
        process.exit(1);
        return;
      }
      console.log(`✓ 삭제 완료: ${proj.name} (${proj.id})`);
    } catch (err) {
      console.error(`× ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// pm task ...
// ----------------------------------------------------------------
const taskCmd = program.command('task').description('태스크 관리');

taskCmd
  .command('add <featureId> <name>')
  .description('태스크 추가')
  .action((featureId, name) => {
    getDb();
    const t = domain.addTask(featureId, name);
    console.log(`✓ 태스크 추가: ${t.name} (#${t.id})`);
  });

taskCmd
  .command('done <id>')
  .description('태스크 완료 처리')
  .action((id) => {
    getDb();
    const t = domain.updateTask(parseInt(id, 10), { status: 'done' });
    if (t) console.log(`✓ 완료: ${t.name}`);
  });

// ----------------------------------------------------------------
// pm ls — print all projects
// ----------------------------------------------------------------
program
  .command('ls')
  .description('등록된 프로젝트 전체 보기')
  .action(() => {
    getDb();
    const projects = domain.listProjects();
    if (projects.length === 0) {
      console.log('등록된 프로젝트가 없습니다.');
      return;
    }
    for (const p of projects) {
      const stats = domain.getProjectStats(p.id);
      console.log(`${p.name} (${p.id})`);
      console.log(`  ${p.root_path}`);
      console.log(`  활성 ${stats.active_features}개, 미완료 태스크 ${stats.todo_tasks}개`);
      console.log('');
    }
  });

// ----------------------------------------------------------------
// pm extract-features [--types feat,fix,refactor] [--min-count N]
//                     [--include-untyped] [--dry-run] [--force]
// Walk this project's sessions, parse conventional-commit subjects, and
// turn each (type, scope) bucket into a feature row + session backfill.
// Idempotent — re-runs hit the extracted_features marker and skip cleanly.
// ----------------------------------------------------------------
program
  .command('extract-features')
  .description('이미 import된 sessions에서 commit prefix를 파싱해 feature 단위로 그룹핑')
  .option('--types <list>', 'CSV로 추출할 type 제한 (conventional 모드, 기본: feat,fix,refactor 등 표준 11종)')
  .option('--min-count <n>', '그룹당 최소 commit 수 (기본 2)', (v) => parseInt(v, 10))
  .option('--include-untyped', 'scope 없는 commit도 type 단위로 묶기 (conventional 모드, 기본 off)')
  .option('--pattern <regex>', '사용자 정의 regex 모드. group 1 또는 (?<scope>…)로 scope 캡처. 지정 시 conventional 모드 무시.')
  .option('--pattern-type <name>', "사용자 정의 모드의 type 라벨 (signature prefix). 기본 'custom'", 'custom')
  .option('--dry-run', '결과 카운트만 출력, DB 변경 없음')
  .option('--force', 'confirm 건너뛰고 즉시 적용')
  .action(async (opts: {
    types?: string;
    minCount?: number;
    includeUntyped?: boolean;
    pattern?: string;
    patternType?: string;
    dryRun?: boolean;
    force?: boolean;
  }) => {
    getDb();
    const project = currentProject();

    const allowTypes = opts.types
      ? opts.types.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const customMode = opts.pattern != null && opts.pattern.length > 0;

    // Dry-run pass first — gives the user concrete counts before they confirm.
    // Wrap in try/catch so regex compile / validation errors land as clean
    // user-facing messages, not stack traces.
    let preview;
    try {
      preview = domain.extractFeaturesFromCommits(project.id, {
        allowTypes,
        minCount: opts.minCount,
        includeUntyped: opts.includeUntyped,
        customPattern: opts.pattern,
        customPatternType: opts.patternType,
        dryRun: true,
      });
    } catch (err) {
      console.error(`× ${(err as Error).message}`);
      process.exit(1);
      return;
    }

    const qualifying = preview.groups.filter((g) => g.outcome === 'dry-run');
    const modeLabel = customMode ? ` (custom pattern mode, type='${opts.patternType ?? 'custom'}')` : '';
    console.log(
      `총 ${preview.groups.length}개 그룹 발견 / 자격 ${qualifying.length}개 (min-count ${opts.minCount ?? 2} 통과)${modeLabel}`,
    );
    for (const g of qualifying) {
      console.log(`  • ${g.signature}  (${g.commitCount}건)`);
    }

    if (opts.dryRun) {
      console.log('\n(--dry-run: DB는 변경되지 않았습니다.)');
      return;
    }
    if (qualifying.length === 0) {
      const hint = customMode
        ? '--pattern을 확인하거나 --min-count를 낮추세요.'
        : '--min-count를 낮추거나 --include-untyped 또는 --pattern을 시도하세요.';
      console.log(`생성할 feature가 없습니다. ${hint}`);
      return;
    }

    if (!opts.force) {
      const ok = await confirmPrompt(`\n${qualifying.length}개 그룹을 적용할까요? (y/N) `);
      if (!ok) {
        console.log('취소했습니다.');
        return;
      }
    }

    const result = domain.extractFeaturesFromCommits(project.id, {
      allowTypes,
      minCount: opts.minCount,
      includeUntyped: opts.includeUntyped,
      customPattern: opts.pattern,
      customPatternType: opts.patternType,
    });
    console.log(
      `✓ 신규 ${result.created}개 / 합치기 ${result.merged}개 / 스킵 ${result.skipped}개 / sessions 백필 ${result.sessionsBackfilled}건`,
    );
  });

// ----------------------------------------------------------------
// pm import-history [--since YYYY-MM-DD] [--limit N] [--dry-run] [--force]
// Walk `git log` in the current project's root and import each commit as a
// synthetic session. Idempotent — re-runs skip already-imported commits.
// ----------------------------------------------------------------
program
  .command('import-history')
  .description('현재 프로젝트의 git history를 sessions로 일괄 import')
  .option('--since <date>', "git --since 값 (예: '2025-01-01' 또는 '2 weeks ago')")
  .option('--limit <n>', '가져올 커밋 최대 개수 (기본 1000)', (v) => parseInt(v, 10))
  .option('--dry-run', '신규/스킵 카운트만 출력, DB 변경 없음')
  .option('--force', 'confirm 건너뛰고 즉시 적용')
  .action(async (opts: { since?: string; limit?: number; dryRun?: boolean; force?: boolean }) => {
    getDb();
    const project = currentProject();

    // First pass: dry-run classification so we know counts before asking
    // for confirm. Always runs even when --dry-run is set (single source of
    // truth for the counts the user sees).
    let preview;
    try {
      preview = await domain.importGitHistory(project.id, {
        since: opts.since,
        limit: opts.limit,
        dryRun: true,
      });
    } catch (err) {
      console.error(`× git log 호출 실패: ${(err as Error).message}`);
      console.error('  현재 디렉토리가 git repo이고 git이 PATH에 있어야 합니다.');
      process.exit(1);
      return;
    }

    console.log(`총 ${preview.total}건 / 신규 ${preview.newCount}건 / 이미 import됨 ${preview.skippedCount}건`);

    if (opts.dryRun) {
      console.log('(--dry-run: DB는 변경되지 않았습니다.)');
      return;
    }
    if (preview.newCount === 0) {
      console.log('새로 import할 커밋이 없습니다.');
      return;
    }

    if (!opts.force) {
      const ok = await confirmPrompt(`\n신규 ${preview.newCount}건을 import할까요? (y/N) `);
      if (!ok) {
        console.log('취소했습니다.');
        return;
      }
    }

    const result = await domain.importGitHistory(project.id, {
      since: opts.since,
      limit: opts.limit,
    });

    console.log(`✓ 신규 ${result.newCount}건 import 완료 (스킵 ${result.skippedCount}건)`);
    if (result.errors.length > 0) {
      console.error(`× ${result.errors.length}건 실패:`);
      for (const e of result.errors) console.error(`  ${e.hash.slice(0, 8)}: ${e.reason}`);
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// pm migrate-claude-md [path] [--dry-run] [--force] [--no-backup]
// Update an existing CLAUDE.md to the current pm-init template. Marker-aware
// so user customisations between markers are preserved (see ADR-0003).
// ----------------------------------------------------------------
program
  .command('migrate-claude-md [path]')
  .description('CLAUDE.md의 Vibemate 섹션을 최신 템플릿으로 업데이트')
  .option('--dry-run', 'diff만 출력, 파일 변경 없음')
  .option('--force', 'confirm 건너뛰고 즉시 적용')
  .option('--no-backup', '.bak 백업 파일을 만들지 않음')
  .action(async (pathArg: string | undefined, opts: { dryRun?: boolean; force?: boolean; backup?: boolean }) => {
    const target = pathArg
      ? path.resolve(pathArg)
      : path.join(process.cwd(), 'CLAUDE.md');

    // Resolve project ID for the template — needed to fill in the {projectId}
    // slot. Falls back to the directory name when no project is registered
    // for this cwd, which is reasonable for `pm migrate-claude-md` invoked
    // before `pm init`.
    getDb();
    const cwd = path.dirname(target);
    const project = domain.getProjectByRoot(cwd);
    const projectId = project?.id ?? path.basename(cwd);

    const result = domain.migrateClaudeMd(target, { projectId });

    if (!result.changed) {
      console.log('변경 사항 없음. 이미 최신 템플릿과 동일합니다.');
      return;
    }

    // Heads-up before showing the diff so the user knows what kind of
    // migration this is. 'legacy' is the riskiest — single marker means
    // we're guessing the section ends at EOF, so user content past that
    // marker (if any) gets pulled into the section and replaced.
    const detectedLabel: Record<typeof result.detected, string> = {
      none: '신규 (마커 없음 — append 또는 새 파일 생성)',
      legacy: '레거시 단일 마커 — 마커→EOF를 섹션으로 가정. 백업 권장',
      paired: '페어 마커 — 안전 교체',
    };
    console.log(`감지: ${detectedLabel[result.detected]}\n`);
    console.log(result.diff);

    if (opts.dryRun) {
      console.log('\n(--dry-run: 파일은 변경되지 않았습니다.)');
      return;
    }

    if (!opts.force) {
      const ok = await confirmPrompt('\n적용할까요? (y/N) ');
      if (!ok) {
        console.log('취소했습니다.');
        return;
      }
    }

    // Backup unless explicitly disabled (--no-backup → opts.backup === false).
    // Skip when the target doesn't exist yet (fresh creation case) since
    // there's nothing to back up.
    let bakPath: string | null = null;
    if (opts.backup !== false && fs.existsSync(target)) {
      bakPath = target + '.bak';
      fs.copyFileSync(target, bakPath);
      console.log(`백업: ${bakPath}`);
    }

    try {
      fs.writeFileSync(target, result.result);
      console.log(`✓ ${target} 업데이트 완료`);
    } catch (err) {
      console.error(`× 쓰기 실패: ${(err as Error).message}`);
      if (bakPath) {
        console.error(`복구하려면: cp "${bakPath}" "${target}"`);
      }
      process.exit(1);
    }
  });

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

// Single-line y/N confirm using readline. Resolves true on 'y'/'yes' (case
// insensitive). Anything else → false (default no, matching the (y/N) hint).
async function confirmPrompt(question: string): Promise<boolean> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function currentProject() {
  const cwd = process.cwd();
  const p = domain.getProjectByRoot(cwd);
  if (!p) {
    console.error(`오류: ${cwd} 는 등록된 프로젝트가 아닙니다.`);
    console.error("'pm init' 으로 먼저 등록하세요.");
    process.exit(1);
  }
  return p;
}

// First-time CLAUDE.md hint emitted by `pm init`. Detection guard preserves
// existing user content — once any vibemate marker (legacy or paired) is
// present, this is a no-op. Use `pm migrate-claude-md` to update.
//
// The actual template body lives in `domain.claudeMdTemplate` so `pm init`
// and `pm migrate-claude-md` stay in lockstep.
function writeClaudeMdHint(cwd: string, projectId: string): void {
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  const section = domain.claudeMdTemplate(projectId);

  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');
    const alreadyHasVibemateSection =
      existing.includes(domain.VIBEMATE_SECTION_BEGIN) ||
      existing.includes(domain.VIBEMATE_LEGACY_MARKER);
    if (alreadyHasVibemateSection) return;
    fs.appendFileSync(claudeMdPath, `\n\n${section}\n`);
    console.log('  → CLAUDE.md에 Vibemate 섹션 추가됨');
  } else {
    fs.writeFileSync(claudeMdPath, `# ${path.basename(cwd)}\n\n${section}\n`);
    console.log('  → CLAUDE.md 생성됨');
  }
}

program.parse();
