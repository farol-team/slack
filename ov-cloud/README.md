# OV Cloud — облачная сторона (Task Router + Slack + OpenViking)

Серверная часть сервиса «Slack Memory / Agent Bridge». Парный проект к
[`ov-runner`](../ov-runner) — тонкому клиенту на Rust + Tauri.
Протокол обмена — зеркало `ov-runner/crates/runner-core/src/protocol.rs`.

## Компоненты

```
app/
├── protocol.py      # pydantic-модели, 1-в-1 с Rust serde (tagged union, snake_case)
├── task_router.py   # реестр runner'ов, жизненный цикл задач, thread ↔ task ↔ session
├── slack_app.py     # Slack Bolt: mentions, кнопки Approve/Deny/Stop, ingestion-буфер
├── memory.py        # HTTP-клиент OpenViking (accounts/users, resources, sessions)
└── main.py          # FastAPI: /runner/v1 (WS), /slack/events, /healthz
```

## Потоки данных

**Задача из Slack → локальный агент:**
```
@app_mention в треде
  → TaskRouter.assign() → AssignTask (WS) → runner
  → runner спавнит `agent --acp` (cwd проверен по allowlist на клиенте)
  → TaskEvent'ы стримятся обратно:
      agent_message_chunk → chat_update одного сообщения (≤1 edit/сек, rate-limit safe)
      tool_call / plan    → статусные реплаи в тред
      permission_request  → Block Kit кнопки Approve / Deny / Stop
  → кнопки → PermissionDecision / CancelTask (WS) → runner → агент
  → TaskResult → финальный статус + кнопка Resume (session_id хранится)
```

**Память (модель C):**
- Все сообщения каналов → `IngestionBuffer` (батчи 50 шт / 5 мин) →
  `OpenViking /{workspace}/resources/slack/{channel}/{date}.md`, L0/L1 генерируются автоматически.
- Runner при подключении передаёт `user_key` OpenViking — облако прокидывает его агенту
  в `AssignTask.memory` как MCP endpoint → агент читает память команды.
- Multi-tenancy нативная: workspace = OpenViking account, ACL делает сам OpenViking.

## Запуск

```bash
cp .env.example .env   # см. переменные ниже
docker compose up --build
```

## Slack-интеграция (мультитенантная)

Flow «Add to Slack» живёт в SaaS-панели (`ov-saas/app`):
пользователь жмёт кнопку → OAuth v2 → callback сохраняет bot token в
`slack_installations` и синкает каналы. Этот сервис **не хранит токены** —
на каждый Slack event резолвит bot token по `team_id` через
`slack.installationByTeam` (tRPC, защищён заголовком `x-internal-secret`).

Переменные:
- `OV_SAAS_URL` + `INTERNAL_API_SECRET` — связка с SaaS (мультитенантный режим);
- `SLACK_BOT_TOKEN` — fallback для dev с одним воркспейсом.

Slack app: scopes `app_mentions:read, channels:read, channels:history,
chat:write, groups:read, groups:history`, Events: `app_mention`,
`message.channels`, Request URL → `https://<host>/slack/events`,
Redirect URL → `https://<saas-host>/api/slack/callback`.

## Решения и допущения MVP

| Что | Сейчас | Production |
|---|---|---|
| Auth runner'а | токен `ovr_{workspace}_{userkey}` | БД + OAuth, ротация ключей |
| Состояние задач | in-memory (`TaskRouter`) | Postgres + Redis streams |
| Маршрутизация | первый runner воркспейса | маппинг Slack user → runner |
| Стриминг в Slack | edit 1×/сек | `chat.startStream` API |
| OpenViking | один сервер, account-изоляция | per-enterprise инстансы |

## Связь с runner'ом

Полный цикл: Slack упоминание → этот сервис → `wss` → ov-runner (Rust) →
`claude --acp` локально → события обратно → рендер в тред. Контракт проверен
round-trip сериализацией на обеих сторонах.
