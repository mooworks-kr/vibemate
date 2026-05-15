# Vibemate

> 🌐 [한국어](./README.md) · **English**

> Vibe-coding project manager — a local-first PM tool that integrates with Claude Code.

Markdown alone scatters your information. **Vibemate** consolidates specs, tasks, code, decisions, and session history into a single SQLite database with bidirectional links — so you never have to ask, *"what did I just build?"*, the classic vibe-coding trap.

- Local-first: all data lives in one file, `~/.vibemate/db.sqlite`
- First-class Claude Code integration: 27 MCP tools exposed
- Web dashboard + CLI + MCP, all running from a single daemon
- Korean / English UI toggle
- Minimal dependencies: Node 22 built-in `node:sqlite` + Hono + custom i18n

---

## Installation

> Vibemate is not yet published to npm. The GitHub-clone path is the only flow that works today; once published, the `npx -y vibemate ...` shortcut will activate.

### 1) Clone the repo + register the global commands

```bash
git clone https://github.com/mooworks-kr/vibemate.git
cd vibemate
npm install
npm run build
npm link            # Makes 'pm' / 'vibemate' available globally
```

Requirements: **Node ≥ 22.5.0** (uses the built-in `node:sqlite`)

### 2) Connect Claude Code

#### Option A — Register MCP directly (simplest)

```bash
claude mcp add vibemate -- pm mcp
```

This adds the vibemate MCP server to `~/.claude.json`. After restarting Claude Code, all `pm_*` tools are available.

> Once published to npm, this becomes a single line: `claude mcp add vibemate -- npx -y vibemate mcp` — no clone needed.

#### Option B — Install as a Plugin (Marketplace-based, better for team distribution)

This repository ships with `.claude-plugin/plugin.json` so it can be installed directly as a Claude Code plugin.

```bash
# 1) Add the marketplace (the repo itself acts as one)
/plugin marketplace add mooworks-kr/vibemate

# 2) Install
/plugin install vibemate@vibemate
```

Installation activates the plugin manifest's `mcpServers` definition automatically — no separate `claude mcp add` step required.

> Listing on the official Anthropic marketplace is separate — once listed, this becomes `/plugin install vibemate`.

---

## First Use

### Register a project

```bash
cd ~/projects/my-project
pm init                     # Registers the project + adds a vibemate guide section to CLAUDE.md
```

`init` safely augments any existing `CLAUDE.md` using paired markers (`<!-- vibemate-section:v2 --> ... <!-- /vibemate-section -->`) — your own content is never touched.

### Daemon + dashboard

```bash
pm start                    # Starts the HTTP daemon (port 7321)
pm dashboard                # Opens http://localhost:7321 in your browser
```

The dashboard supports a Korean/English toggle and unified navigation across projects, features, decisions, sessions, documents, and search.

### Working with Claude Code

When Claude Code is connected to vibemate, the natural flow becomes:

- Session start → `pm_session_start` automatically loads the in-progress context
- Starting work on a feature → `pm_set_active_feature` surfaces its `spec_md`
- For meaningful decisions → `pm_log_decision` writes an ADR
- Session end → `pm_session_end({notes})` so the next session can "continue from where you left off"
- Bundle a feature's full context to your clipboard → `pm_get_context_brief` (8-section single Markdown)

### Other commands

```bash
pm status                   # Daemon status
pm stop                     # Stop the daemon
pm import-history           # Bulk-import the current git history as sessions
pm extract-features         # Auto-extract features from commit prefixes
pm migrate-claude-md        # Update existing CLAUDE.md vibemate sections to the latest template
pm ls                       # List all registered projects
pm help <command>           # Per-command details
```

---

## Key Features

| Area | What it does |
|------|--------------|
| **Spec Hub** | Per-feature `spec_md` + 6 document kinds (PRD/Planning/Architecture/Retro/Feature Spec/Other) with M:N feature mapping |
| **Decisions (ADR)** | Attachable to features, indexed for FTS5 search, surfaced in feature detail |
| **Sessions** | Session-grained work log with file changes auto-derived from `git status` (no chokidar watcher; ADR-0018) |
| **Feature Flow Map** | Feature detail integrates related code / decisions / docs / sessions + per-file last-edit metadata (ADR-0022) |
| **AI Context Pack** | Bundles a feature's context into a single 8-section Markdown for clipboard / Claude (ADR-0021) |
| **Session Intelligence** | Notes written at session-end auto-surface at the next session-start (ADR-0020) |
| **Project Overview** | Per-project health (active / todo_only / archived / empty) + next action + recent sessions (ADR-0017) |
| **Cross-project Workspace** | Unified view of in-progress features across every registered project |
| **Global Search** | SQLite FTS5 + BM25 weighting (feature 1.0 / decision 0.9 / document 0.8 / session 0.6) + Cmd+K palette |
| **Git History Import** | Convert `git log` to sessions in bulk; auto-extract features from conventional commit prefixes |
| **i18n** | Korean / English UI toggle (ADR-0023) |

---

## Data Location

```
~/.vibemate/
├── db.sqlite           # All projects, unified (SQLite WAL)
├── db.sqlite-wal
└── daemon.pid          # Daemon PID tracking
```

**The DB is the single source of truth.** Markdown / documents are export artifacts. To back up, copy `db.sqlite` and the WAL file together.

---

## Architecture at a Glance

```
src/
├── server/                  # Node.js 22+ (built-in node:sqlite)
│   ├── cli.ts                # commander entry point
│   ├── daemon.ts             # HTTP background daemon
│   ├── mcp.ts                # Claude Code MCP server (27 tools)
│   ├── http.ts               # Hono REST API + static file serving
│   ├── domain.ts             # Single source of business logic
│   ├── db.ts                 # SQLite schema
│   ├── migrations/           # 0001–0006 SQL
│   └── types.ts              # ★ Importable from web (pure type)
└── web/                     # Vite + TypeScript + vanilla DOM
    ├── index.html
    ├── i18n.ts               # ko/en dictionary + t() + persist
    ├── persist.ts            # localStorage helpers
    ├── types.ts              # Web interface definitions
    └── main.ts               # Single entry point (strict typed)
```

**Dependency direction**: `cli/daemon/mcp/http → domain → db → (lib, types)`
**One daemon, one port**: 7321 serves the HTTP API + static files; MCP is a separate stdio process.

---

## Development / Contributing

### Dev mode (HMR)

```bash
npm run dev                  # Server (7321) + Vite (5173) concurrently
# Browser hits 5173 — /api requests are auto-proxied to 7321
```

### Build / test

```bash
npm run build                # dist/server + dist/web
npm run typecheck            # All 3 tsconfigs pass strict
npm test                     # 222 unit tests (domain / migrations / i18n / persist)
npm run test:coverage        # v8 reporter
```

### CLAUDE.md

If you're working on vibemate itself with Claude Code, read [CLAUDE.md](./CLAUDE.md) first for the guidelines (no `console.log` in MCP / `types.ts` pure type / route registration order, etc.). The known auto-test surface (domain + migrations + i18n + persist) is documented; HTTP routes / MCP / UI are manual E2E.

---

## Changelog

Per-sprint changes are queryable via `pm_get_context` or the dashboard's **Decisions (ADR)** tab — ADR-0001 through ADR-0024 accumulate there (vibemate is dogfooded against itself, so the records live in vibemate's own DB). A standalone changelog for external readers is on the roadmap.

---

## Known Limitations

- Auto-tests cover domain / migrations / migrate-claude-md / context-brief / i18n / persist. HTTP routes / MCP / UI are manual E2E.
- Korean search matches word-prefixes only (no infix matching; ADR-0009).
- Search is indexed across 4 entity kinds: feature / decision / session / document. Tasks and files are not indexed (ADR-0005/0010/0016/0019).
- Bidirectional spec.md file sync is not implemented.
- Server-side i18n (e.g. Korean-emitted `relativeTime`) is on the roadmap — current i18n is web-only (ADR-0023).

---

## Help / Feedback

- Issues / PRs: https://github.com/mooworks-kr/vibemate
- When reporting an issue, please include `pm status` output, repro steps, and your Node version (`node -v`).

---

## License

[MIT](./LICENSE) © 2026 jin (mooworks-kr)
