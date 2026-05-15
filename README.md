# Vibemate

> 바이브 코딩 프로젝트 매니저 — Claude Code 와 연동되는 로컬 PM 툴

마크다운만으로는 정보가 흩어진다. **Vibemate** 는 스펙 / 태스크 / 코드 / 결정 / 세션 히스토리를 한 SQLite DB 에 모으고 양방향으로 링크해서, "내가 뭘 만들었지?" 라는 바이브 코딩의 함정을 푼다.

- 로컬 우선: 모든 데이터는 `~/.vibemate/db.sqlite` 한 파일
- Claude Code 와 1급 통합: MCP 서버로 27 개 툴 노출
- 웹 대시보드 + CLI + MCP 가 한 데몬에서 동시 동작
- 한국어 / English UI 토글
- 외부 의존성 최소: Node 22 빌트인 `node:sqlite` + Hono + 자체 i18n

---

## 설치

> 현재 npm registry 에 publish 전이라 GitHub 에서 직접 받는 흐름만 동작합니다. publish 후에는 `npx -y vibemate ...` 로 단축됩니다.

### 1) 저장소 클론 + 전역 명령 등록

```bash
git clone https://github.com/mooworks-kr/vibemate.git
cd vibemate
npm install
npm run build
npm link            # 'pm' / 'vibemate' 명령 전역 사용 가능
```

요구사항: **Node ≥ 22.5.0** (`node:sqlite` 빌트인 사용)

### 2) Claude Code 에 연결

#### 방법 A — MCP 직접 등록 (가장 단순)

```bash
claude mcp add vibemate -- pm mcp
```

`~/.claude.json` 에 vibemate MCP 서버가 등록된다. Claude Code 재시작 후 `pm_*` 툴들이 사용 가능.

> npm publish 이후에는 `claude mcp add vibemate -- npx -y vibemate mcp` 로 clone 없이 한 줄.

#### 방법 B — Plugin 으로 설치 (Marketplace 기반, 팀 배포에 유리)

이 저장소는 `.claude-plugin/plugin.json` 을 포함해 Claude Code 플러그인으로 직접 설치 가능합니다.

```bash
# 1) Marketplace 등록 (저장소 자체를 marketplace 로)
/plugin marketplace add mooworks-kr/vibemate

# 2) 설치
/plugin install vibemate@vibemate
```

설치 시 plugin manifest 의 `mcpServers` 정의가 자동으로 활성화되어 별도 `claude mcp add` 가 필요 없습니다.

> Anthropic 공식 marketplace 등록은 별도 — 등록되면 `/plugin install vibemate` 로 단축됩니다.

---

## 첫 사용

### 프로젝트 등록

```bash
cd ~/projects/내-프로젝트
pm init                     # 프로젝트 등록 + CLAUDE.md 에 vibemate 가이드 섹션 추가
```

`init` 은 기존 `CLAUDE.md` 가 있으면 paired marker (`<!-- vibemate-section:v2 --> ... <!-- /vibemate-section -->`) 로 안전하게 vibemate 섹션만 추가/갱신합니다 — 사용자가 직접 쓴 내용은 절대 건드리지 않습니다.

### 데몬 + 대시보드

```bash
pm start                    # HTTP 데몬 (포트 7321) 시작
pm dashboard                # 브라우저로 http://localhost:7321 열기
```

대시보드에서 한국어/영어 토글, 프로젝트 / 기능 / 결정 / 세션 / 문서 / 검색 통합 탐색이 가능합니다.

### Claude Code 와 협업

Claude Code 에서 vibemate 가 등록되면 다음 흐름이 자연스럽게 동작합니다:

- 세션 시작 시 `pm_session_start` → 진행 컨텍스트 자동 로드
- feature 작업 시작 시 `pm_set_active_feature` → spec_md 자동 surface
- 의미 있는 결정 시 `pm_log_decision` 으로 ADR 기록
- 세션 종료 시 `pm_session_end({notes})` → 다음 세션이 "이어서 작업" 가능
- feature 컨텍스트 통째로 클립보드 복사: `pm_get_context_brief` (8 섹션 단일 Markdown)

### 기타 명령

```bash
pm status                   # 데몬 상태
pm stop                     # 데몬 종료
pm import-history           # 현재 git history 를 sessions 로 일괄 import
pm extract-features         # commit prefix 에서 feature 자동 추출
pm migrate-claude-md        # 기존 CLAUDE.md vibemate 섹션을 최신 템플릿으로
pm ls                       # 등록된 프로젝트 전체 목록
pm help <command>           # 명령별 상세
```

---

## 핵심 기능

| 영역 | 내용 |
|------|------|
| **Spec Hub** | feature 별 spec_md + documents 6 종 (PRD/Planning/Architecture/Retro/Feature Spec/Other) M:N 매핑 |
| **Decisions (ADR)** | feature 에 attach 가능, FTS5 검색 인덱싱, feature 상세에 노출 |
| **Sessions** | 세션 단위 작업 기록 + `git status` 기반 변경 파일 자동 derive (chokidar 워처 없음, ADR-0018) |
| **Feature Flow Map** | feature 상세에 관련 코드 / 결정 / 문서 / 세션 + 파일별 최근 수정 통합 표시 (ADR-0022) |
| **AI Context Pack** | feature 컨텍스트 8 섹션 단일 Markdown 으로 묶어 클립보드 / Claude 에 전달 (ADR-0021) |
| **Session Intelligence** | 세션 종료 시 작성한 notes 가 다음 세션 시작 시 자동 surface (ADR-0020) |
| **Project Overview** | 프로젝트별 health (active / todo_only / archived / empty) + 다음 작업 + 최근 세션 (ADR-0017) |
| **Cross-project Workspace** | 모든 프로젝트의 진행 중 features 통합 view |
| **Global Search** | SQLite FTS5 + BM25 가중치 (feature 1.0 / decision 0.9 / document 0.8 / session 0.6) + Cmd+K palette |
| **Git History Import** | `git log` → sessions 일괄 변환, conventional commit prefix → feature 자동 추출 |
| **i18n** | 한국어 / English UI 토글 (ADR-0023) |

---

## 데이터 위치

```
~/.vibemate/
├── db.sqlite           # 모든 프로젝트 통합 (SQLite WAL)
├── db.sqlite-wal
└── daemon.pid          # 데몬 PID 추적
```

**DB 가 단일 source of truth.** 마크다운/문서는 export 산출물. 백업은 `db.sqlite` + WAL 두 파일을 같이 복사하면 됩니다.

---

## 아키텍처 한눈에

```
src/
├── server/                  # Node.js 22+ (node:sqlite 빌트인)
│   ├── cli.ts                # commander 진입점
│   ├── daemon.ts             # HTTP 백그라운드 데몬
│   ├── mcp.ts                # Claude Code MCP 서버 (27 툴)
│   ├── http.ts               # Hono REST API + 정적 파일 서빙
│   ├── domain.ts             # 비즈니스 로직 단일 소스
│   ├── db.ts                 # SQLite 스키마
│   ├── migrations/           # 0001–0006 SQL
│   └── types.ts              # ★ 웹에서도 import 가능 (pure type)
└── web/                     # Vite + TypeScript + vanilla DOM
    ├── index.html
    ├── i18n.ts               # ko/en 사전 + t() + persist
    ├── persist.ts            # localStorage 헬퍼
    ├── types.ts              # 웹 인터페이스 정의
    └── main.ts               # 단일 entry point (strict typed)
```

**의존 방향**: `cli/daemon/mcp/http → domain → db → (lib, types)`
**한 데몬, 한 포트**: 7321 에서 HTTP API + 정적 파일 + (별도) MCP stdio.

---

## 개발 / 기여

### 개발 모드 (HMR)

```bash
npm run dev                  # 서버(7321) + Vite(5173) 동시
# 브라우저는 5173 — /api 요청은 자동 7321 프록시
```

### 빌드 / 테스트

```bash
npm run build                # dist/server + dist/web
npm run typecheck            # 3 tsconfig 모두 strict 통과
npm test                     # 222 단위 테스트 (도메인 / migrations / i18n / persist)
npm run test:coverage        # v8 reporter
```

### CLAUDE.md

Claude Code 로 vibemate 자체를 작업한다면 [CLAUDE.md](./CLAUDE.md) 의 가이드 (MCP stdout 금지 / `types.ts` pure type / 라우트 등록 순서 등) 를 먼저 읽으세요. 자동 테스트 범위 (도메인 + migrations + i18n + persist) 는 알려져 있고, HTTP 라우트 / MCP / UI 는 수동 E2E 입니다.

---

## 변경 이력

세부 sprint 단위 변경은 `pm_get_context` / 대시보드 의 **결정 (ADR)** 탭에서 조회할 수 있습니다 (ADR-0001 ~ ADR-0023 누적, vibemate 자체가 dogfood 되어 vibemate DB 에 기록됨). 외부 readers 를 위한 changelog 는 추후 정리 예정.

---

## 알려진 제약

- 자동 테스트는 도메인 / migrations / migrate-claude-md / context-brief / i18n / persist 범위. HTTP 라우트 / MCP / UI 는 수동 E2E.
- 한국어 검색은 어절 시작 매칭만 (어절 중간 매칭 미지원, ADR-0009).
- 검색 인덱싱은 feature / decision / session / document 4 종 (tasks / file 미인덱싱, ADR-0005/0010/0016/0019).
- 양방향 spec.md 파일 동기화 미구현.
- Server 측 i18n (`relativeTime` 한국어 emit 등) 은 후속 — 현재 i18n 은 web 한정 (ADR-0023).

---

## 도움 / 피드백

- Issue / PR: https://github.com/mooworks-kr/vibemate
- 사용 중 문제 발생 시 `pm status` 출력 + 재현 단계 + Node 버전 (`node -v`) 함께 보내주세요.

---

## License

[MIT](./LICENSE) © 2026 jin (mooworks-kr)
