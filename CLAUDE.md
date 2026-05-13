# Vibemate — Claude Code 개발 가이드

이 디렉토리는 **Vibemate 자체의 코드베이스**다. 사용자 프로젝트가 아닌, 툴 자체를 개발/유지보수하는 컨텍스트.

## 아키텍처 한눈에

```
src/
├── server/          # Node.js 백엔드 (MCP + HTTP + DB + CLI)
│   ├── cli.ts            # commander 진입점
│   ├── daemon.ts         # HTTP 백그라운드 데몬 (chokidar 제거됨, Sprint 21)
│   ├── mcp.ts            # Claude Code가 stdio로 호출 (27개 툴)
│   ├── http.ts           # Hono REST API + 정적 파일 서빙 (31 routes)
│   ├── domain.ts         # 비즈니스 로직 단일 소스
│   ├── db.ts             # SQLite (node:sqlite) + 스키마
│   ├── migrations.ts     # migration runner + schema_migrations 테이블
│   ├── migrations/       # 0001-0006 SQL
│   ├── git-import.ts     # pm import-history (Sprint 12)
│   ├── extract-features.ts  # pm extract-features (Sprint 13/14)
│   ├── lib.ts            # 슬러그/시간/ignore 패턴
│   └── types.ts          # ★ 웹에서도 import 가능 (pure type)
└── web/             # 대시보드 UI
    ├── index.html
    ├── types.ts          # 웹 인터페이스 정의 (Sprint 8)
    ├── persist.ts        # localStorage 헬퍼 (Sprint 18)
    └── main.ts           # vanilla TS — strict 타입화 완료
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

`src/server/migrations/` 디렉토리에 SQL 파일 추가 (`000N_<name>.sql`). `migrations.ts`가 `schema_migrations` 테이블로 적용 이력 추적. 현재 0001(init), 0002(search_fts FTS5 + 트리거), 0003(imported_commits), 0004(extracted_features), 0005(drop file_explanations), 0006(documents + document_features + FTS 트리거 3) 적용됨. 새 마이그레이션 추가 시 `migrations.test.ts`에 인덱스/트리거 존재 검증 추가 권장.

### 웹 ↔ 서버 타입 공유

서버의 `types.ts`는 **pure type only**로 유지. runtime import (예: `import { something }`)를 추가하면 Vite가 그 코드를 번들에 포함하려다 Node API 등에서 실패함. `import type` 또는 인터페이스/타입 alias만 OK.

### 정적 파일 경로

`http.ts`가 `dist/web/`을 root로 `serveStatic`. 이 경로는 `import.meta.url` 기반으로 계산되어 dev(src/server/)와 prod(dist/server/) 양쪽에서 모두 `<project>/dist/web/`을 가리킴. 빌드 안 한 dev 모드에선 dist/web/이 없어서 fallback이 비활성화됨 (Vite가 5173에서 처리하므로 OK).

## 테스트

### 자동 (단위)

vitest. 도메인 + migrations 커버, HTTP 라우트/MCP/UI는 미커버 (수동 E2E로 검증).

```bash
npm test                # 194 tests — domain/migrations/HTTP-스모크/migrate-claude-md/import/extract/workspace/setActiveFeature/documents/session-detail/context-brief (Sprint 24)
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

## 프론트엔드

Sprint 8 에서 `@ts-nocheck` 제거 완료. `src/web/types.ts` 가 모든 인터페이스 정의 (Sprint 22/23 에서 Document/SessionDetail/LastSessionSummary 등 추가). 신규 view는 Sprint 22 documents 패턴(`currentDocument` state → `renderDocumentDetail` dispatch)을 따른다. Sprint 23 sessions sub-view 도 동일.

프레임워크(Svelte/React) 도입은 다음 조건이 동시에 충족될 때만:
- 라우팅이 진짜 필요해짐 (단순 탭 + sub-view state로 부족)
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

- 검색 인덱싱은 feature/decision/session/document 4종 (file/task 미인덱싱 — ADR-0005/0009/0010/0016/0019).
- 자동 테스트는 도메인/migrations 한정 (`npm test` — 183 tests) — HTTP 라우트 / MCP / UI 는 수동 E2E.
- 양방향 spec.md 파일 동기화 미구현.
- **AI 파일 설명 / Code Map은 Sprint 16(ADR-0016)에서 제거됨.** `sessions.files`와 `feature_files` 매핑은 유지 (Sprint 4-5의 핵심).
- **chokidar 워처는 Sprint 21(ADR-0018)에서 제거됨.** `deriveSessionFiles` 가 `git status --porcelain` 으로 endSession 시점에 derive (policy B uncommitted only).
- `last_session.notes_excerpt` 는 Sprint 23 이후 `pm_session_end({notes})` 로 작성된 세션부터 의미 있음.

<!-- vibemate-section:v2 -->
<!-- vibemate-template-version: 4 -->

## 이 프로젝트는 Vibemate가 활성화되어 있습니다

**Project ID**: `vibemate`

세션 시작 시:
1. `pm_session_start` 호출 → session_id 저장
2. `pm_get_context` 호출 → 진행 상태 / 최근 결정 / 다음 태스크 확인
3. 응답의 `spec_md` 가 있으면 **작업 시작 전 반드시 읽기** — 범위 / 비범위 / 의존 / 결정 항목 확인

Feature 작업 시작 시 (다른 기능으로 전환할 때 포함):
1. `pm_set_active_feature` 호출 → 응답의 `spec_md` / `feature.goal` / `feature.next_task` 확인
2. 또는 `pm_get_context(feature_id=X)` 로 명시 조회
3. **`spec_md` 의 "범위 / 비범위 / 의존" 섹션을 작업 결정 전 검토**
4. 검토 중 새로 정한 정책은 `pm_log_decision` 으로 ADR 기록

세션 중 의미있는 결정이 있으면:
- `pm_log_decision` 으로 ADR 기록 제안 (사용자 confirm 후 호출)

세션 종료 직전:
- `pm_session_end` 호출 (session_id, summary, primary_feature_id, **notes**)
- **summary**: 한 줄 핵심 — 검색 / 카드 노출에 사용. 한국어 권장.
- **notes**: 구조화된 Markdown — 다음 세션이 "이어서 작업" 할 수 있게 정리.
  예:
  ```
  ## 완료
  - 구현 / 수정한 항목
  ## 남은 일
  - 미완료 항목 + 다음 세션이 시작할 위치
  ## 결정
  - 의식적으로 정한 정책 (큰 결정은 `pm_log_decision` 으로 별도 ADR 기록)
  ```
- 이 `notes` 의 첫 200자가 다음 세션 시작 시 `pm_get_context` 의 `last_session.notes_excerpt` 로 노출됨.

태스크 / 기능 변경:
- 태스크 시작: `pm_update_task` (status=in_progress)
- 태스크 완료: `pm_update_task` (status=done)
- 새 기능: `pm_create_feature`

<!-- /vibemate-section -->
