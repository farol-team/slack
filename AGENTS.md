# AGENTS.md — Slack Memory / Agent Bridge

## Обзор проекта

Монорепозиторий из трёх компонентов, вместе образующих сервис «Slack Memory / Agent
Bridge»: упоминание бота в Slack превращается в задачу, которая выполняется локальным
coding-агентом на машине разработчика, а память команды хранится в OpenViking.

```
 Slack ──Events API──► ov-cloud (Python/FastAPI) ──wss──► ov-runner (Rust/Tauri)
      ◄──рендер в тред──        ▲                            │ spawn
                                │ tRPC (x-internal-secret)   ▼
                          app/ (SaaS-панель,          локальный агент
                          React + Hono + MySQL)       claude/gemini --acp (stdio)
```

- **`app/`** — SaaS-панель управления (control plane): веб-интерфейс на React 19 + Vite,
  бэкенд на Hono + tRPC, MySQL через Drizzle ORM, аутентификация через Kimi OAuth.
  Хранит воркспейсы, runner'ы, каналы, задачи и Slack-инсталляции (bot tokens).
- **`ov-cloud/`** — облачный сервис (data plane) на Python/FastAPI: принимает Slack Events
  (Slack Bolt), держит WebSocket `/runner/v1` для runner'ов, маршрутизирует задачи
  (`TaskRouter`), стримит события обратно в Slack, пишет сообщения каналов в OpenViking.
  Bot token резолвится per-team через tRPC-API `app/` (`slack.installationByTeam`,
  заголовок `x-internal-secret`); не хранит токены сам.
- **`ov-runner/`** — тонкий клиент на Rust: Cargo workspace с ядром `crates/runner-core`
  и Tauri 2 десктоп-приложением `apps/desktop`. Живёт в трее, держит **исходящее**
  wss-соединение с облаком (ноль открытых портов), выполняет задачи на локальном агенте
  через ACP (JSON-RPC 2.0 поверх stdio).

Модель памяти: Slack workspace = OpenViking account (граница tenant'а); сообщения каналов
батчами (50 шт / 5 мин) пишутся в `/{workspace}/resources/slack/{channel}/{date}.md`;
агент получает MCP endpoint OpenViking через `AssignTask.memory`.

## Структура кода

### app/ (TypeScript, Node 20, ESM)
- `api/` — серверная часть: `boot.ts` (точка входа Hono), `router.ts` (корневой tRPC
  router: `auth`, `workspace`, `runner`, `memory`, `billing`, `slack`),
  `middleware.ts` (процедуры `publicQuery`/`authedQuery`/`adminQuery`),
  `saas-router.ts` (доменная логика SaaS), `slack-oauth.ts` (OAuth v2 «Add to Slack»),
  `kimi/` (Kimi OAuth), `queries/` (доступ к БД), `lib/` (env, cookies, vite-интеграция).
- `contracts/` — типы/константы, общие для клиента и сервера (re-export типов из `db/schema`).
- `db/` — Drizzle ORM: `schema.ts`, `relations.ts`, `seed.ts`, `migrations/` (MySQL).
- `src/` — фронтенд: `main.tsx`, `App.tsx` (react-router: `/`, `/login`,
  `/dashboard/{runners,memory,settings}`), `pages/`, `components/ui/` (shadcn, 40+
  компонентов), `hooks/`, `providers/trpc.tsx`.
- Алиасы путей (vite + tsconfig): `@/* → src/*`, `@contracts/* → contracts/*`,
  `@db/* → db/*`.

### ov-cloud/ (Python 3.12)
- `app/protocol.py` — pydantic-модели протокола, зеркало `protocol.rs`.
- `app/task_router.py` — реестр runner'ов и жизненный цикл задач (in-memory).
- `app/slack_app.py` — Slack Bolt: mentions, кнопки Approve/Deny/Stop, IngestionBuffer.
- `app/memory.py` — HTTP-клиент OpenViking. `app/importer.py` — импорт истории каналов.
- `app/main.py` — FastAPI: `/runner/v1` (WS), `/slack/events`, `/internal/import/*`
  (защищены `x-internal-secret`), `/healthz`.

### ov-runner/ (Rust, edition 2021)
- `crates/runner-core/src/` — `protocol.rs` (контракт сообщений, serde tagged union),
  `acp.rs` (ACP-клиент), `cloud.rs` (WS loop с reconnect/backoff), `session.rs`
  (SessionManager), `config.rs` (конфиг + OS keychain для токена).
- `apps/desktop/` — Tauri 2: `ui/index.html` (без сборщика, withGlobalTauri),
  `src-tauri/` (tray, IPC-команды, автозапуск).

## Команды сборки и тестирования

### app/ (npm)
```bash
npm run dev           # Vite dev-сервер на :3000 (Hono через @hono/vite-dev-server)
npm run build         # vite build + esbuild api/boot.ts → dist/boot.js
npm start             # NODE_ENV=production node dist/boot.js (порт PORT или 3000)
npm run check         # tsc -b (проверка типов, tsconfig.app/node/server)
npm run lint          # eslint .
npm run format        # prettier --write .
npm test              # vitest run (только api/**/*.test.ts|spec.ts)
npm run db:generate   # drizzle-kit generate (нужен DATABASE_URL)
npm run db:migrate    # drizzle-kit migrate
npm run db:push       # drizzle-kit push
```

### ov-cloud/ (Python)
```bash
cp .env.example .env
docker compose up --build   # поднимает сервис на :8000 + OpenViking на :1933
# локально: pip install -r requirements.txt && uvicorn app.main:app --port 8000
```

### ov-runner/ (Rust)
```bash
cargo check                        # проверка ядра (в корне ov-runner/)
cd apps/desktop && npm install
npm run dev                        # cargo tauri dev
npm run build                      # cargo tauri build (.app/.msi/.deb)
```
Требования: Rust stable, Node 18+, системные зависимости Tauri 2.

## Соглашения по коду

- **Языки документации/комментариев:** русский в `ov-cloud/` и `ov-runner/`, английский
  в `app/` (шаблонный код). Следуйте языку окружающего файла.
- **app/**: Prettier (double quotes, semi, trailing comma es5, width 80), ESLint flat
  config (tseslint recommended + react-hooks + react-refresh). tRPC-процедуры через
  `publicQuery` / `authedQuery` / `adminQuery` из `api/middleware.ts`; трансформер —
  superjson. UI — shadcn-компоненты из `@/components/ui`.
- **Схема БД** (`app/db/schema.ts`): PK — `serial()`; FK на serial PK обязаны быть
  `bigint("col", { mode: "number", unsigned: true })`. Enum'ы — `mysqlEnum`.
- **Протокол cloud ↔ runner — двойное зеркало**: `ov-runner/crates/runner-core/src/protocol.rs`
  (serde, `#[serde(tag = "type", rename_all = "snake_case")]`) и
  `ov-cloud/app/protocol.py` (pydantic) должны меняться синхронно; snake_case-теги и
  имена полей совпадают 1-в-1. Контракт проверен round-trip сериализацией.
- Сообщения протокола: `hello`, `assign_task`, `task_event`, `permission_decision`,
  `cancel_task`, `task_result`, `ping`/`pong`, `error`.

## Тестирование

- Витест настроен в `app/` (`vitest.config.ts`, environment `node`, include
  `api/**/*.test.ts` / `*.spec.ts`) — **тестов пока нет**; новые тесты кладите рядом с
  кодом в `api/` под эти паттерны.
- В `ov-cloud/` и `ov-runner/` тестов нет; для runner'а запланированы mock-агент по ACP
  и mock-cloud по протоколу (см. `ov-runner/README.md`).
- Минимальная проверка перед сдачей: `npm run check` + `npm run lint` (app),
  `cargo check` (ov-runner), импорт/запуск uvicorn (ov-cloud).

## Безопасность

- Секреты только через env: `app/.env.example`, `ov-cloud/.env.example` — шаблоны;
  реальные `.env` не коммитить (есть в `.gitignore`).
- Runner-токены (`ovr_{workspace}_{userkey}`): в БД хранится только SHA-256-хэш
  (`runners.tokenHash`); на клиенте токен — в OS keychain, не в файле.
- Slack bot tokens хранятся в `slack_installations` (пометка в коде: production —
  шифровать через KMS). Внутренние вызовы SaaS ↔ ov-cloud защищены заголовком
  `x-internal-secret` (`INTERNAL_API_SECRET`).
- На runner'е `allowed_cwds` — жёсткий allowlist директорий для задач; destructive
  actions агента подтверждаются кнопками Approve/Deny в Slack.
- Slack OAuth state — одноразовые токены в `slack_oauth_states` (CSRF-защита).

## Деплой и окружение

- **ov-cloud**: `docker compose up --build` (Dockerfile на `python:3.12-slim`, uvicorn
  на :8000) + sidecar `volcengine/openviking:latest` на :1933 (volume `ov-data`).
- **app**: `npm run build && npm start`; статика из `dist/public`, сервер — `dist/boot.js`.
- **ov-runner**: Tauri-бандлы (`npm run build` в `apps/desktop`), планируются подпись и
  автообновления (`tauri-plugin-updater`).
- Slack app: Request URL → `https://<host>/slack/events` (ov-cloud), Redirect URL →
  `https://<saas-host>/api/slack/callback` (app); scopes и events перечислены в
  `ov-cloud/README.md`.

## Известные MVP-ограничения (из ov-cloud/README.md)

Состояние задач — in-memory `TaskRouter` (production: Postgres + Redis); маршрутизация —
первый runner воркспейса; стриминг в Slack — edit 1×/сек (production: `chat.startStream`);
один сервер OpenViking с account-изоляцией.
