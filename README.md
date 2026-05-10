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

### ✓ 완료 (Sprint 1-11)

**기반 (Sprint 1-3)**
- 도메인 레이어 E2E
- HTTP API + 단일 포트(7321) API/정적 파일 서빙
- Vite dev 프록시, 빌드 파이프라인
- 멀티 프로젝트 + 자동 파일 매핑 (confidence 0.7~0.85)

**Sprint 4-7 — 핵심 기능**
- 파일트리 API (`GET /api/projects/:id/file-tree`)
- 웹 mock → 실제 API wire-up
- Mutation UI: feature/task/ADR 풀 CRUD + 매핑 끊기 + 헬퍼 통일 (`mutate`/`validateRequired`/`showToast`)
- AI 파일 설명 워크플로우: `pm_list_files_needing_explanation` 큐 + `pm_clear_file_explanation` 강제 재생성
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
- 단위 테스트 38 → **110** (도메인/migrations/migrate-claude-md/import-git-history/extract-features +pattern)

### 다음 백로그 후보

- `[Maintenance]` `main.ts` 잔존 `any` ~42건 narrow (Sprint 8 후속)
- 검색 한계 재검토: 한국어 형태소 분석기/임베딩 (ADR-0009 비범위)
- tasks 검색 인덱싱 재검토: 운영 데이터로 가치 재평가 (ADR-0010 비범위)
- 다른 source import: jira/notion/linear (Sprint 12의 `imported_<source>` 패턴 확장)
- 양방향 spec.md 동기화 (미구현 명시)

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

Sprint 4-11 ADR (vibemate DB에 ADR-0001~0011 기록, 웹 대시보드 또는 `pm_get_context`로 조회):
- 0001 API 에러 응답: list = 200+`[]`, 단일 = 404+`{error}`
- 0002 삭제 정책: feature=archive, task/decision=hard delete + decision PATCH 지원
- 0003 AI 파일 설명: edit_type {modified, created} 필터 + 강제 재생성=DELETE 캐시 + CLAUDE.md 마이그레이션은 명시 트리거만
- 0004 검색 BM25: title 3:1 가중치 + kind multiplier (feature 1.0 / decision 0.9 / file 0.7 / session 0.6)
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

## 알려진 제약

- 자동 테스트는 도메인/migrations/migrate-claude-md 한정 (`npm test` — 66 tests). HTTP 라우트 / MCP / UI는 수동 E2E.
- 큰 monorepo에서 chokidar 파일 워처 성능 미검증.
- AI 파일 설명은 Claude Code MCP 호출(`pm_get_file_content` + `pm_save_file_explanation`)로 처리 — vibemate가 직접 LLM API를 호출하지 않으므로 별도 API 키 불필요.
- 검색의 `file` 카인드는 `file_explanations`이 채워진 파일에 한정 (트리 전체에 자동 인덱싱은 안 함).
- 한국어 검색은 어절 시작 매칭만 가능 (어절 중간 매칭은 미지원, ADR-0009).
- tasks는 검색 인덱싱 대상 아님 (ADR-0005/0010 — noise 우려).
- 양방향 spec.md 파일 동기화 미구현.
