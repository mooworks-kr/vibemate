---
name: vibemate
description: Vibemate(바이브 코딩 프로젝트 매니저) 개발팀 — 팀리더가 기획/관리하고, Developer가 구현, QA가 검증하는 구조
agents:
  - name: developer
    role: Vibemate 코드 구현 담당. 팀리더가 기획한 태스크를 받아 실제 코드로 만든다.
    subagent_type: general-purpose
  - name: qa
    role: Developer가 구현한 결과를 E2E 시나리오로 검증하고 회귀를 확인한다.
    subagent_type: general-purpose
tasks:
  - subject: 파일트리 API 엔드포인트 구현
    description: |
      `GET /api/projects/:id/file-tree` 엔드포인트를 추가한다. 코드 맵 탭에서 사용할 데이터 소스.

      요구사항:
      - 프로젝트 root 경로 아래의 파일 트리를 재귀적으로 탐색
      - `lib.ts`의 ignore 패턴을 적용 (node_modules, .git, dist 등)
      - 응답 형식: `{ name, path, type: 'file'|'dir', children? }` 재귀 구조
      - `domain.ts`에 `getFileTree(projectId)` 함수 추가
      - `http.ts`에서 `/*` static fallback보다 먼저 라우트 등록
      - `types.ts`에 `FileNode` 타입 추가 (웹에서도 사용 가능하도록 pure type)

      참고: README.md의 "다음 작업 (우선순위)" 2번 항목.
    owner: developer
  - subject: 파일트리 API 검증
    description: |
      파일트리 엔드포인트 동작 확인:
      - 빌드/타입체크 통과
      - HOME=/tmp/vibemate-test 격리 환경에서 프로젝트 init 후 file-tree 호출
      - ignore 패턴이 제대로 작동하는지(node_modules가 응답에 없는지) 확인
      - 존재하지 않는 projectId 입력 시 에러 응답 형식 확인
      - 기존 API 엔드포인트(/api/projects 등) 회귀 없음
    owner: qa
    blockedBy: [1]
  - subject: 웹 mock 데이터를 실제 API로 교체
    description: |
      `src/web/main.ts` 상단의 `DATA = { ... }` mock 객체를 실제 `fetch('/api/...')` 호출로 교체.

      요구사항:
      - `import type { Project, Feature } from '../server/types'` 사용 (pure type import)
      - 프로젝트 목록, 기능 목록을 API에서 로드
      - 로딩 상태 / 에러 상태 처리 (간단해도 됨)
      - 기존 `// @ts-nocheck`는 일단 유지(점진 마이그레이션은 별도 태스크)
      - 파일트리 데이터도 새로 만든 `/api/projects/:id/file-tree`에서 로드

      참고: README.md의 "다음 작업 (우선순위)" 1번 항목, CLAUDE.md "프론트엔드 마이그레이션 메모".
    owner: developer
    blockedBy: [1]
  - subject: 웹 API 통합 검증
    description: |
      Mock → API 교체가 완료된 뒤:
      - `npm run dev`로 dev 서버 + Vite 동시 실행
      - 브라우저에서 5173 접속해서 프로젝트/기능/파일트리가 실제 API로부터 로드되는지 확인
      - `npm run build` && `npm start`로 프로덕션 빌드도 확인 (포트 7321)
      - 기존 mock에서 보이던 데이터와 동일한 UI 동작인지 확인
      - 네트워크 에러 시 UI가 깨지지 않는지(에러 처리) 확인
    owner: qa
    blockedBy: [3]
---

## 프로젝트 컨텍스트

**Vibemate**는 바이브 코딩 프로젝트 매니저. Claude Code와 MCP로 연동되어 스펙/태스크/코드/결정/세션 히스토리를 SQLite 한 곳에 모으는 로컬 PM 툴.

### 기술 스택

- **백엔드**: Node.js 22+ (node:sqlite 빌트인 사용), Hono(HTTP), MCP SDK, chokidar(파일 감시), commander(CLI)
- **프론트엔드**: Vite, TypeScript, vanilla DOM (프레임워크 없음)
- **빌드**: 단일 프로젝트, `dist/server/`(tsc) + `dist/web/`(vite)
- **포트**: dev=5173(web)+7321(api), prod=7321(통합)

### 핵심 파일

- `src/server/cli.ts` — commander 진입점
- `src/server/daemon.ts` — HTTP + 워처 백그라운드 데몬
- `src/server/mcp.ts` — Claude Code stdio MCP 서버 (11개 툴)
- `src/server/http.ts` — Hono REST API + 정적 파일 서빙
- `src/server/domain.ts` — 비즈니스 로직 단일 소스 (모든 새 기능은 여기로)
- `src/server/db.ts` — SQLite 스키마
- `src/server/types.ts` — ★ 웹/서버 공유 타입 (pure type only)
- `src/web/main.ts` — 1100라인 vanilla JS, 현재 `// @ts-nocheck` + mock 데이터

### 현재 우선순위 (README.md 기준)

1. ✅ 도메인/HTTP/MCP 검증 완료
2. **Mock → API wire-up** ← 이번 스프린트
3. **파일트리 엔드포인트** ← 이번 스프린트
4. Mutation UI (다음 스프린트 후보)
5. AI 파일 설명 생성 (다음 스프린트 후보)
6. 글로벌 검색 FTS5 (다음 스프린트 후보)

### 작업 원칙

- **CLAUDE.md 항상 참조** — 특히 MCP stdout 금지, types.ts pure type, 라우트 등록 순서
- 의존 방향: `cli/daemon/mcp/http → domain → db → (lib, types)`
- 자동 테스트 없음 → QA는 수동 E2E 시나리오로 검증
- 마이그레이션 시스템 없음 → 스키마 변경 태스크 시 주의

## 워크플로우

1. 팀리더가 스프린트 단위로 태스크 기획 → TaskCreate로 등록
2. Developer가 구현 태스크를 받아 작업 → TaskUpdate(`completed`) → 팀리더 보고
3. QA는 의존성으로 unblock된 검증 태스크 실행 → 통과 시 completed, 실패 시 새 태스크로 버그 보고
4. 모든 태스크 완료 후에도 에이전트는 대기 (팀리더가 다음 스프린트 기획 중)
