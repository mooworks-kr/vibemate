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

### ✓ 검증 완료

- 도메인 레이어 E2E (10개 시나리오)
- HTTP API 6개 엔드포인트 응답 형식
- 단일 포트(7321)에서 API + 정적 파일 동시 서빙
- Vite dev 모드에서 /api 프록시
- 빌드 파이프라인 (서버 tsc + 웹 vite)
- 멀티 프로젝트 지원
- 자동 파일 매핑 (confidence 0.7~0.85)

### ⚠ 다음 작업 (우선순위)

1. **Mock → API wire-up** — `src/web/main.ts`의 `DATA = { ... }`을 `fetch('/api/...')` 호출로 교체. `src/server/types.ts`에서 타입 import해서 안전성 확보.
2. **파일트리 엔드포인트 추가** — `GET /api/projects/:id/file-tree`. 코드 맵 탭에 필요.
3. **Mutation UI** — 새 기능/태스크 추가, 매핑 끊기 폼.
4. **AI 파일 설명 생성** — 세션 종료 hook에서 Claude API 호출 → `file_explanations` 캐시.
5. **글로벌 검색** — SQLite FTS5 + Cmd+K palette.

## 데이터 위치

```
~/.vibemate/
├── db.sqlite             # 모든 프로젝트 통합
├── db.sqlite-wal
└── daemon.pid
```

## 디자인 결정 (지금까지의 ADR)

- **DB가 소스, MD는 export**. 1차 저장소는 SQLite, 필요 시 마크다운으로 동기화.
- **MCP + HTTP 동시 운영**. 같은 데몬 프로세스에서 SQLite WAL로 동시 쓰기.
- **node:sqlite (Node 22 빌트인)** 사용. native build 의존성 제거. 필요 시 `db.ts`만 교체.
- **자동 매핑 + 수동 보정**. 세션 종료 시 touch한 파일을 active feature에 confidence 0.7~0.85로 자동 매핑.
- **단일 프로젝트 구조**. 백엔드/프론트엔드를 분리하지 않음 — 로컬 데스크톱 앱이라 분리 이유 없음. 같은 레포에서 타입 공유 + 단일 빌드.

## 알려진 제약

- 자동 테스트 없음 (E2E는 수동)
- 마이그레이션 시스템 없음
- AI 파일 설명 생성 미구현 (스키마만 존재)
- 글로벌 검색 미구현
- 다크 모드 미구현
- 양방향 spec.md 파일 동기화 미구현
