# Vibemate — Claude Code 개발 가이드

이 디렉토리는 **Vibemate 자체의 코드베이스**다. 사용자 프로젝트가 아닌, 툴 자체를 개발/유지보수하는 컨텍스트.

## 아키텍처 한눈에

```
src/
├── server/          # Node.js 백엔드 (MCP + HTTP + DB + CLI)
│   ├── cli.ts            # commander 진입점
│   ├── daemon.ts         # HTTP + 워처 백그라운드 데몬
│   ├── mcp.ts            # Claude Code가 stdio로 호출 (19개 툴)
│   ├── http.ts           # Hono REST API + 정적 파일 서빙
│   ├── watcher.ts        # chokidar 파일 감시
│   ├── domain.ts         # 비즈니스 로직 단일 소스
│   ├── db.ts             # SQLite (node:sqlite) + 스키마
│   ├── lib.ts            # 슬러그/시간/ignore 패턴
│   └── types.ts          # ★ 웹에서도 import 가능 (pure type)
└── web/             # 대시보드 UI (현재 mockup 단계)
    ├── index.html
    └── main.ts           # 인라인 스크립트에서 추출됨, 현재 @ts-nocheck
```

**의존 방향**: cli/daemon/mcp/http → domain → db → (lib, types)
**타입 공유**: `web/main.ts`에서 `import type { Feature } from '../server/types'` 가능. types.ts는 순수 타입만 갖도록 유지할 것.

## 빌드 / 실행 모드

### 개발 (HMR)

```bash
npm run dev
# 자동으로:
#   - 서버: tsx watch src/server/cli.ts -- start  (포트 7321)
#   - 웹:   vite                                  (포트 5173)
# 브라우저는 5173 열기. /api 요청은 vite.config.ts가 7321로 프록시.
```

서버만 또는 웹만:
```bash
npm run dev:server
npm run dev:web
```

### 프로덕션

```bash
npm run build      # 양쪽 다 빌드 (dist/server + dist/web)
npm start          # = node dist/server/cli.js start (포트 7321)
# 7321이 정적 파일까지 서빙 — 브라우저는 7321 열면 됨
```

### 타입 체크만

```bash
npm run typecheck  # 서버 + 웹 둘 다
```

## 변경 시 주의사항

### MCP 툴 추가/변경

`mcp.ts`에 zod 스키마와 함께 등록. 새 툴은 `domain.ts`에 함수를 만들고 wrapper로 노출. **MCP는 stdout이 protocol channel** — `pm mcp` 실행 시 어디서도 `console.log` 하면 안 됨 (cli.ts나 daemon.ts에선 OK).

### HTTP 엔드포인트 추가

`http.ts`에 추가. domain 함수를 호출하는 wrapper로. **API 라우트는 `/*` 정적 fallback보다 먼저 등록**되어야 함 — 현재는 모든 `/api/*` 라우트 → `app.use('/*', serveStatic)` 순서.

### 스키마 변경

`src/server/migrations/` 디렉토리에 SQL 파일 추가 (`000N_<name>.sql`). `migrations.ts`가 `schema_migrations` 테이블로 적용 이력 추적. 현재 0001(init), 0002(search_fts FTS5 + 트리거 12개) 적용됨. 새 마이그레이션 추가 시 `migrations.test.ts`에 인덱스/트리거 존재 검증 추가 권장.

### 웹 ↔ 서버 타입 공유

서버의 `types.ts`는 **pure type only**로 유지. runtime import (예: `import { something }`)를 추가하면 Vite가 그 코드를 번들에 포함하려다 Node API 등에서 실패함. `import type` 또는 인터페이스/타입 alias만 OK.

### 정적 파일 경로

`http.ts`가 `dist/web/`을 root로 `serveStatic`. 이 경로는 `import.meta.url` 기반으로 계산되어 dev(src/server/)와 prod(dist/server/) 양쪽에서 모두 `<project>/dist/web/`을 가리킴. 빌드 안 한 dev 모드에선 dist/web/이 없어서 fallback이 비활성화됨 (Vite가 5173에서 처리하므로 OK).

## 테스트

### 자동 (단위)

vitest. 도메인 + migrations 커버, HTTP 라우트/MCP/UI는 미커버 (수동 E2E로 검증).

```bash
npm test                # 66 tests — projects/features/sanitizer/searchProject/migrations/endSession/getFileContent/saveFileExplanation/migrate-claude-md/tasks/decisions/feature_files
npm run test:watch
npm run test:coverage   # v8 reporter
```

테스트는 `os.tmpdir()`에 격리된 SQLite 파일을 쓰므로 사용자의 `~/.vibemate/`를 건드리지 않음. `src/server/__tests__/helpers.ts`의 `createTempDb()` 패턴 참고.

### 수동 (E2E)

```bash
HOME=/tmp/vibemate-test node dist/server/cli.js init --name "테스트"
HOME=/tmp/vibemate-test node dist/server/cli.js feature add "기능 1"
HOME=/tmp/vibemate-test node dist/server/cli.js start --port 7333 &
curl -s http://localhost:7333/api/projects | jq
HOME=/tmp/vibemate-test node dist/server/cli.js stop
```

## 프론트엔드 마이그레이션 메모

`src/web/main.ts`는 현재 `// @ts-nocheck` 상태. 1100라인 vanilla JS를 그대로 옮긴 것이므로 다음 작업 시 점진적으로 타입 입혀갈 것:

1. `DATA` mock 객체부터 `fetch()` 호출로 교체 — 이때 `import type { Project, Feature } from '../server/types'` 사용
2. `state` 객체 타입 정의
3. DOM 헬퍼(`el()`)에 제너릭 타입 추가
4. 점진적으로 `@ts-nocheck` 제거

프레임워크(Svelte/React) 도입은 다음 조건이 동시에 충족될 때만:
- 라우팅이 진짜 필요해짐 (단순 탭 state로 부족)
- 컴포넌트 재사용이 많아짐
- 글로벌 store가 필요해짐

지금은 vanilla로 충분.

## 디자인 토큰 (CSS 변수)

`src/web/index.html`의 `:root` 안에 정의. 새 색은 가능한 기존 토큰 재사용:

- 배경: `--bg`, `--bg-sidebar`, `--bg-elevated`, `--bg-soft`, `--bg-hover`
- 텍스트: `--text`, `--text-2`, `--text-3`
- 보더: `--border`, `--border-strong`
- 의미적: `--accent`(포레스트 그린), `--warn`(앰버), `--info`(인디고)
- 폰트: Pretendard(한국어/영문), JetBrains Mono(코드)

## 알려진 제약

- 큰 monorepo에서 chokidar 파일 워처 성능 미검증.
- AI 파일 설명은 Claude Code MCP 호출(`pm_get_file_content` + `pm_save_file_explanation`)로 처리 — vibemate가 직접 LLM API를 호출하지 않으므로 별도 API 키 불필요.
- 검색의 `file` 카인드는 `file_explanations`이 채워진 파일에만 매칭.
- 자동 테스트는 도메인/migrations 한정 — HTTP 라우트 / MCP / UI 는 수동 E2E.
- 양방향 spec.md 파일 동기화 미구현.


<!-- Vibemate section — added by 'pm init'. Edit freely. -->

## 이 프로젝트는 Vibemate가 활성화되어 있습니다

**Project ID**: `vibemate`

세션 시작 시:
1. `pm_session_start` 호출 → session_id 저장
2. `pm_get_context` 호출 → 진행 상태 / 최근 결정 / 다음 태스크 확인

세션 중 의미있는 결정이 있으면:
- `pm_log_decision` 으로 ADR 기록 제안 (사용자 confirm 후 호출)

세션 종료 직전:
- `pm_session_end` 호출 (session_id, 한 줄 요약, primary_feature_id)
- summary는 한국어 권장. 어떤 기능을 어떻게 진행했는지 명확하게.

태스크 / 기능 변경:
- 태스크 시작: `pm_update_task` (status=in_progress)
- 태스크 완료: `pm_update_task` (status=done)
- 새 기능: `pm_create_feature`
