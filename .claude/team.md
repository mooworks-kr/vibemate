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
