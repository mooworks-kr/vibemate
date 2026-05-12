# Vibemate

> 바이브 코딩 프로젝트 매니저 — Claude Code와 연동되는 로컬 PM 툴

마크다운만으로는 정보가 흩어진다. **Vibemate**는 스펙 / 태스크 / 코드 / 결정 / 세션 히스토리를 한 SQLite DB에 모으고 양방향으로 링크해서, "내가 뭘 만들었지?" 라는 바이브 코딩의 함정을 푼다.

## 구조

```
vibemate/
├── package.json              # 단일 프로젝트
├── tsconfig.json             # 웹 (Vite + DOM)
├── tsconfig.server.json      # 서버 (Node)
├── vite.config.ts
├── README.md
├── CLAUDE.md                 # Claude Code용 개발 가이드
└── src/
    ├── server/               # Node.js: MCP + HTTP API + 파일 워처 + CLI
    │   ├── cli.ts
    │   ├── daemon.ts
    │   ├── mcp.ts
    │   ├── http.ts
    │   ├── domain.ts         # 비즈니스 로직 (MCP/HTTP 양쪽 호출)
    │   ├── db.ts             # SQLite (node:sqlite)
    │   ├── watcher.ts
    │   ├── lib.ts
    │   └── types.ts          # ★ 웹에서도 import 가능
    └── web/                  # 대시보드 UI (현재 mockup)
        ├── index.html
        └── main.ts
```

빌드 결과는 `dist/server/`(Node 실행) + `dist/web/`(정적 자산). 데몬(`pm start`)은 같은 포트 7321에서 API와 정적 파일을 모두 서빙한다.

## 개발 / 실행

### 첫 셋업

```bash
npm install
npm run build
npm link              # 'pm', 'vibemate' 명령 전역 등록
```

### 개발 모드 (HMR)

```bash
npm run dev           # 서버(7321) + Vite(5173) 동시 실행
# 브라우저에서 http://localhost:5173 열기
# /api 요청은 자동으로 7321로 프록시됨
```

### 프로덕션 (사용자 환경)

```bash
cd ~/projects/내-프로젝트
pm init               # 프로젝트 등록 + CLAUDE.md 자동 추가
pm start              # 데몬 시작
pm dashboard          # http://localhost:7321 브라우저로 열기
```

Claude Code MCP 설정 (`~/.claude.json` 등):

```json
{
  "mcpServers": {
    "vibemate": { "command": "pm", "args": ["mcp"] }
  }
}
```

## 진행 상황

### ✓ 완료 (Sprint 1-23)

**기반 (Sprint 1-3)**
- 도메인 레이어 E2E
- HTTP API + 단일 포트(7321) API/정적 파일 서빙
- Vite dev 프록시, 빌드 파이프라인
- 멀티 프로젝트 + 자동 파일 매핑 (confidence 0.7~0.85)

**Sprint 4-7 — 핵심 기능**
- 파일트리 API (`GET /api/projects/:id/file-tree`) — *Sprint 16에서 제거*
- 웹 mock → 실제 API wire-up
- Mutation UI: feature/task/ADR 풀 CRUD + 매핑 끊기 + 헬퍼 통일 (`mutate`/`validateRequired`/`showToast`)
- ~~AI 파일 설명 워크플로우~~ — *Sprint 16(ADR-0016)에서 제거. `sessions.files`와 `feature_files` 매핑은 유지.*
- 글로벌 검색: SQLite FTS5 + BM25 가중치(title 3:1, KIND multiplier) + Cmd+K palette + 결과 점프

**Sprint 8-11 — 품질/도구**
- 프론트엔드 점진적 타입화: `// @ts-nocheck` 제거 + tsc strict + `src/web/types.ts` (16 인터페이스)
- `pm migrate-claude-md` 명령: 4 vintage 분기(none/no-marker/paired/legacy) + Project ID 보존 + .bak 백업
- 측정 인프라: `scripts/measure-search.ts`, `compare-trigram.ts`, `measure-tasks-search.ts` — 향후 토크나이저/인덱싱 정책 재검토 자산

**Sprint 12 — 기존 작업 import**
- `pm import-history [--since][--limit][--dry-run][--force]` 명령 + `pm_import_git_history` MCP 툴
- git log → vibemate sessions 일괄 변환 (commit hash 멱등성, edit_type 매핑 A/M/T/R/C, D 스킵)
- 새 마이그레이션 `0003_imported_commits.sql`: PK(project_id, commit_hash)로 중복 차단, cascade delete

**Sprint 13 — 과거 feature 추출 (conventional)**
- `pm extract-features [--types][--min-count][--include-untyped][--dry-run][--force]` + `pm_extract_features_from_commits` MCP 툴
- conventional commit prefix(`feat(scope):`/`fix(scope):` 등)에서 (type, scope) 그룹핑 → vibemate feature 자동 생성 + sessions.feature_id backfill
- type whitelist 11종 + scope 필수 + case-insensitive 이름 머지 + min-count 3 default
- 새 마이그레이션 `0004_extracted_features.sql`: PK(project_id, source_signature)

**Sprint 14 — 사용자 정의 regex 추출**
- `pm extract-features --pattern <regex> --pattern-type <name>` 추가 — gitmoji + 마일스톤 같은 비-conventional 패턴 지원
- named group `(?<scope>...)` 우선, fallback group 1
- conventional과 namespace 분리 (`milestone:M37` vs `feat:auth` 공존)
- ADR-0013 정책 그대로 적용 (min-count, 머지, IS NULL 가드)

**Sprint 15 — Cross-project 워크스페이스**
- 사이드바 최상단 `📋 내 작업` 탭 + `GET /api/workspace/active-features?status=&limit=` + `pm_list_workspace_features` MCP 툴
- 모든 프로젝트의 진행 중 features 통합 view (single endpoint, N+1 회피)
- 카드 클릭 → 해당 프로젝트 + feature로 navigate
- `currentTab` default `'features'` → `'workspace'` (멀티 프로젝트 사용자 진입 흐름 개선)

**Sprint 16 — Code Map 완전 제거 (ADR-0016)**
- AI 파일 설명 / 코드 맵 탭 제거: 실제 사용량이 가설보다 낮고 유지비용 > 가치
- HTTP 24 → **20** (file-tree / files/detail / files/needs-explanation / file-explanations 제거)
- MCP 22 → **18** (pm_get_file_content / pm_save_file_explanation / pm_list_files_needing_explanation / pm_clear_file_explanation 제거)
- 마이그레이션 `0005_drop_file_explanations.sql`: DROP TABLE + 트리거 3개 + search_fts file kind row 일괄 정리
- Frontend: TABS 6 → **5** (codemap 부재), `renderCodeMap`/`loadFileDetail`/`clearExplanationUI` 제거, `searchProject` 방어 필터 (`kind != 'file'`)
- **보존**: `sessions.files` 표시 (sessions 탭 + feature detail), `feature_files` 매핑 (POST/DELETE `/api/feature-files` + `/api/features/:fid/files`), chokidar watcher
- 단위 테스트 38 → **119 → 103** (Sprint 16에서 -16, +1 회귀 가드)
- 번들 50.28 KB → **40.84 KB** (-19% — codemap UI + 4 file 함수 제거)

**Sprint 17 — spec_md 작업 흐름 (ADR-0017)**
- `pm_set_active_feature` 응답에 `spec_md` 포함 → Claude Code 가 feature 시작 시 자동 surface
- `setActiveProject` 시 `currentTab === 'workspace'` 면 자동으로 features 탭 전환
- claudeMdTemplate v3: feature 작업 시작 시 spec_md 검토 가이드 추가

**Sprint 18 — 완료 항목 접기 + workspace 확장**
- 사이드바 완료 features 토글 (Option C, localStorage `vibemate.hideCompleted`)
- `pm_get_context` / workspace endpoint 가 in_progress + todo 모두 반환 (이전: in_progress 만)
- STATUS_PRIORITY 정렬: in_progress > todo > done > archived

**Sprint 19 — Active features Cross-project 강화**
- workspace endpoint 카드에 next_task / unread_decisions count surface
- spec_md 결정 항목 ADR 자동 연결 (Sprint 17 흐름 후속)

**Sprint 20 — Project Overview (ADR-0017 후속)**
- `dashboard` → `overview` 탭 리네임 + `GET /api/projects/:id/overview`
- `ProjectHealth` 4-status (active / todo_only / archived / empty) — in_progress 기준 + needs_review fallback
- 최근 세션 + active features + 우선 다음 작업 묶음

**Sprint 21 — chokidar 제거 (ADR-0018)**
- 파일 워처 완전 삭제 → `git status --porcelain` at `endSession` (policy B: uncommitted only)
- EMFILE 근본 해결 + 의존성 chokidar 제거
- `watcher.ts` 삭제, `deriveSessionFiles` 도메인 함수로 대체
- launchd plist fd 한도 10240 → 65536 (보험)

**Sprint 22 — Spec Hub (ADR-0019)**
- documents 데이터 모델 + M:N feature 매핑 (`documents` + `document_features`)
- HTTP +8 routes (CRUD + features mapping + active_documents) / MCP +6 tools
- 새 마이그레이션 `0006_documents.sql`: 6 kind enum + FTS5 통합 (weight 0.8, KIND_WEIGHT 확장)
- Frontend: `docs` 탭 추가 + `renderDocumentDetail` + `renderMarkdownLite` (50 LOC)
- features.spec_md 와 documents 양립 — spec_md = feature scope, documents = 자료 hub
- claudeMdTemplate v3 active_documents 가이드 보강

**Sprint 23 — Session Intelligence (ADR-0020)**
- `pm_get_context.last_session` 자동 surface (active_feature 있을 때) — `notes_excerpt` 200자
- `pm_session_end({notes})` optional 파라미터 + COALESCE 보존 (Sprint 12 import-history 무회귀)
- 새 HTTP `GET /api/sessions/:id` (404 graceful) + 새 MCP `pm_get_session_detail`
- Frontend: sessions 탭 sub-view drill-in (`currentSession` state) + prev/next 네비 + Overview 카드 → drill-in
- claudeMdTemplate v3 → **v4**: `## 완료 / ## 남은 일 / ## 결정` 구조화 가이드 + `last_session` 노출 안내. 마커 v2 유지.
- HTTP 29 → **30** (+1), MCP 25 → **26** (+1), tests 169 → **183** (+14), 번들 57.63 → **61.97 KB** (+4.34 KB)
- 스키마 변경 0 (기존 notes 컬럼 재활용)

### 다음 백로그 후보

- `[Maintenance]` `main.ts` 잔존 `any` narrow (Sprint 8 후속)
- AI Context Pack (`ijze`): 다음 세션 prompt 생성 — Sprint 23 비범위
- Feature Flow Map: feature 간 의존/링크 시각화
- 검색 한계 재검토: 한국어 형태소 분석기/임베딩 (ADR-0009 비범위)
- tasks 검색 인덱싱 재검토: 운영 데이터로 가치 재평가 (ADR-0010 비범위)
- 다른 source import: jira/notion/linear (Sprint 12의 `imported_<source>` 패턴 확장)
- 양방향 spec.md 동기화 (미구현 명시)
- agent별 작업 흐름 구분 (Codex/Claude 등) — Sprint 23 비범위

## 데이터 위치

```
~/.vibemate/
├── db.sqlite             # 모든 프로젝트 통합
├── db.sqlite-wal
└── daemon.pid
```

## 디자인 결정

기반 결정 (Sprint 1-3):
- **DB가 소스, MD는 export**. 1차 저장소는 SQLite, 필요 시 마크다운으로 동기화.
- **MCP + HTTP 동시 운영**. 같은 데몬 프로세스에서 SQLite WAL로 동시 쓰기.
- **node:sqlite (Node 22 빌트인)** 사용. native build 의존성 제거. 필요 시 `db.ts`만 교체.
- **자동 매핑 + 수동 보정**. 세션 종료 시 touch한 파일을 active feature에 confidence 0.7~0.85로 자동 매핑.
- **단일 프로젝트 구조**. 백엔드/프론트엔드를 분리하지 않음 — 로컬 데스크톱 앱이라 분리 이유 없음.

Sprint 4-23 ADR (vibemate DB에 ADR-0001~0020 기록, 웹 대시보드 또는 `pm_get_context`로 조회):
- 0001 API 에러 응답: list = 200+`[]`, 단일 = 404+`{error}`
- 0002 삭제 정책: feature=archive, task/decision=hard delete + decision PATCH 지원
- 0003 ~~AI 파일 설명~~: edit_type {modified, created} 필터 + 강제 재생성=DELETE 캐시 — **historical (ADR-0016에서 기능 자체가 제거됨)**
- 0004 검색 BM25: title 3:1 가중치 + kind multiplier (feature 1.0 / decision 0.9 / ~~file 0.7~~ / session 0.6 / document 0.8)
- 0005 검색 인덱싱 범위: tasks 미인덱싱 + tokenizer 옵션 미적용
- 0006 인벤토리 우선 워크플로우 (스프린트 첫 task는 항상 인벤토리)
- 0007 프론트엔드 타입화: types-first + ElProps loose union, @ts-nocheck 제거는 strict 통과 시
- 0008 CLAUDE.md 마커: v2 페어(`<!-- vibemate-section:v2 --> ... <!-- /vibemate-section -->`) + 버전 태그 + Project ID 보존
- 0009 trigram 미도입 (측정 데이터 기반): 한국어 2자 키워드 0 hit
- 0010 tasks 인덱싱 미도입 (측정 재확인): noise-probe 49%
- 0011 측정-기반 의사결정 sprint 패턴 (회고)
- 0012 git import: imported_commits 테이블(옵션 B) + spawn array + edit_type 매핑(D 스킵)
- 0013 commit prefix → feature: type whitelist + scope 필수 + case-insensitive 머지 + min-count 3
- 0014 사용자 정의 regex 추출: named scope 우선 + custom 모드 분리 + 그룹 0 reject + 패턴 길이 200
- 0015 Workspace view: 단일 endpoint + Tab union 확장 + 사이드바 dual-mode + mark 클라 계산
- 0016 Code Map / AI 파일 설명 제거: 실 사용량이 가설보다 낮음 + 유지비용 > 가치
- 0017 spec_md 작업 흐름: `pm_set_active_feature` 응답에 spec_md 포함 + setActiveProject 자동 탭 전환 + claudeMdTemplate v3
- 0018 파일 워처 제거: chokidar EMFILE 근본 해결 + `git status --porcelain` at endSession (policy B uncommitted only)
- 0019 Spec Hub: documents 모델 + kind 6종 + features.spec_md 양립 + FTS5 노출(weight 0.8) + simple textarea
- 0020 Session Intelligence: notes Markdown 구조화 + getContext.last_session surface + claudeMdTemplate v4

## 알려진 제약

- 자동 테스트는 도메인/migrations/migrate-claude-md 한정 (`npm test` — 183 tests). HTTP 라우트 / MCP / UI는 수동 E2E.
- ~~큰 monorepo에서 chokidar 파일 워처 성능 미검증.~~ — Sprint 21(ADR-0018) chokidar 제거됨.
- 한국어 검색은 어절 시작 매칭만 가능 (어절 중간 매칭은 미지원, ADR-0009).
- 검색 인덱싱은 feature/decision/session/document 4종 (ADR-0005/0010/0016/0019 — tasks/file 미인덱싱).
- 양방향 spec.md 파일 동기화 미구현.
- AI 파일 설명 / Code Map은 Sprint 16(ADR-0016)에서 제거됨. `sessions.files`와 `feature_files` 매핑은 유지 (Sprint 4-5).
- `last_session.notes_excerpt` 는 사용자가 `pm_session_end({notes})` 패턴으로 구조화 작성한 세션부터 의미 있음 (Sprint 23). 기존 import-history 세션의 notes_excerpt 는 0자.
