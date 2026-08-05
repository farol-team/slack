# Project context (read before touching code)

Monorepo for **Farol**: mentioning the bot in Slack creates a task that
runs on a local coding agent on a developer's machine; team memory lives
in OpenViking. Full architecture: `CLAUDE.md` and `AGENTS.md` (keep both
in sync when conventions change).

## Execution targets

| target | dir | stack | check before claiming done |
|---|---|---|---|
| `app` | `app/` | React 19 + Vite, Hono + tRPC, Drizzle/PostgreSQL, Node 20 ESM | `cd app && npm run check && npm run lint && npm test` |
| `cloud` | `cloud/` | Python 3.12, FastAPI, Slack Bolt | `cd cloud && python -m compileall -q app` (no test suite yet; uvicorn must import) |
| `runner` | `runner/` | Rust stable, Cargo workspace + Tauri 2 | `cd runner && cargo check` (`cargo test --workspace` when tests exist) |

## Conventions that bite

- **Protocol double mirror**: `runner/crates/farol-core/src/protocol.rs`
  and `cloud/app/protocol.py` define the same wire contract — change both
  in the same diff (constitution Article P1).
- **app/** path aliases: `@/* → src/*`, `@contracts/*`, `@db/*`. tRPC
  goes through `publicQuery`/`authedQuery`/`adminQuery` from
  `api/middleware.ts`; superjson transformer; shadcn UI from
  `@/components/ui`. Prettier: double quotes, semicolons, es5 commas,
  width 80.
- **DB schema** (`app/db/schema.ts`): `serial()` PKs, `integer()` FKs,
  `pgEnum` at the top of the file.
- **Vitest** only in `app/` (`api/**/*.test.ts|spec.ts`, node env) —
  put new tests next to the code in `api/`.
- **Language**: English for all new comments/docs; translate legacy
  Russian comments opportunistically when touching them.
- **Secrets**: env only; `.env.example` is the template. Runner tokens
  are hash-only in DB (`runners.tokenHash`).

## Commit format

Conventional commits with a scope matching the target dir:
`feat(app): …`, `fix(cloud): …`, `feat(runner): …`, `docs: …`.
Imperative mood, lower-case after the colon, no trailing period.
