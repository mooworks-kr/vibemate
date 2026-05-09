#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import * as domain from './domain.js';
import { getDb } from './db.js';
import { startDaemon, stopDaemon, daemonStatus } from './daemon.js';
import { startMcpServer } from './mcp.js';

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
// pm start | stop | status
// ----------------------------------------------------------------
program
  .command('start')
  .description('데몬 시작 (HTTP 서버 + 파일 감시)')
  .option('-p, --port <port>', '포트', '7321')
  .action(async (opts) => {
    getDb();
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

program
  .command('status')
  .description('데몬 상태 확인')
  .action(() => {
    const s = daemonStatus();
    if (s.running) console.log(`✓ 실행 중 (pid ${s.pid})`);
    else console.log('✗ 실행 중이 아님');
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
