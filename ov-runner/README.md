# OV Runner — тонкий клиент (Rust + Tauri)

Тонкий клиент сервиса **Slack Memory / Agent Bridge**: живёт в системном трее на машине
разработчика, держит **исходящее** WebSocket-соединение с облаком и выполняет задачи
из Slack на локальном coding-агенте через **ACP (Agent Client Protocol)**.

## Архитектура

```
 Slack                       Cloud (SaaS)                  Этот клиент
┌────────┐  Events API   ┌──────────────┐   wss (outbound) ┌──────────────────────┐
│ @бот   │──────────────►│ Task Router  │◄────────────────►│ OV Runner (Tauri)    │
│ в треде│               │ + OpenViking │                  │  ├─ cloud.rs   WS+   │
└───▲────┘                └──────┬───────┘                  │  │           reconnect│
    │  chat.postMessage          │ AssignTask               │  ├─ acp.rs   JSON-RPC│
    └────────────────────────────┘                          │  │           over stdio
         (стрим чанков, кнопки Approve/Deny, Stop)          │  ├─ session.rs      │
                                                            │  └─ config.rs +     │
                                                            │     keychain        │
                                                            └─────────┬───────────┘
                                                                      │ spawn
                                                            ┌─────────▼───────────┐
                                                            │ claude --acp /      │
                                                            │ gemini --acp (локал.)│
                                                            └─────────────────────┘
```

Принципы:
- **Ноль открытых портов**: клиент всегда сам устанавливает соединение (`cloud.rs`).
- **Агент как подпроцесс**: JSON-RPC 2.0 поверх stdio (`acp.rs`), без привязки к конкретному
  агенту — работает любой ACP-совместимый (Claude Code, Gemini CLI, Codex, Kimi CLI…).
- **Память из облака**: `AssignTask.memory` содержит MCP endpoint OpenViking; клиент
  прокидывает его агенту при `session/new` — агент получает память команды.
- **Безопасность**: `allowed_cwds` — жёсткий allowlist директорий; токен в OS keychain,
  не в файле; destructive actions подтверждаются кнопками в Slack
  (`session/request_permission` → Slack → `PermissionDecision`).

## Структура

```
ov-runner/
├── crates/runner-core/        # проверено cargo check ✅
│   └── src/
│       ├── protocol.rs        # контракт сообщений cloud ↔ runner
│       ├── acp.rs             # ACP-клиент (JSON-RPC stdio)
│       ├── cloud.rs           # WebSocket loop с reconnect/backoff
│       ├── session.rs         # SessionManager: задача → ACP-сессия
│       └── config.rs          # конфиг + keychain (токен)
└── apps/desktop/              # Tauri 2 приложение
    ├── ui/index.html          # статус/логин (без сборщика, withGlobalTauri)
    └── src-tauri/
        ├── src/lib.rs         # tray, IPC-команды, автозапуск
        ├── tauri.conf.json
        └── capabilities/default.json
```

## Сборка и запуск

Требования: Rust stable, Node 18+, [системные зависимости Tauri](https://v2.tauri.app/start/prerequisites/).

```bash
cd apps/desktop
npm install
npm run dev      # dev-режим с окном
npm run build    # production-бандлы (.app/.msi/.deb)
```

Ядро можно проверить отдельно: `cargo check` в корне workspace.

## Протокол (wss, JSON)

| Сообщение | Направление | Назначение |
|---|---|---|
| `hello` | → | auth (token), версии, список агентов |
| `assign_task` | ← | Slack-mention: prompt, thread, cwd, agent, memory-конфиг |
| `task_event` | → | стрим: chunk / tool_call / plan / permission_request |
| `permission_decision` | ← | Approve/Deny из Slack-кнопки |
| `cancel_task` | ← | Stop |
| `task_result` | → | финальный статус + session_id (для resume) |

## Что дальше (production)

1. **Login через OAuth device-flow** вместо вставки токена.
2. Автообновления (`tauri-plugin-updater`) + подпись бинарников.
3. Детект установленных агентов (`which claude`, `which gemini`) при старте.
4. Очередь задач и ограничение параллелизма (сейчас: одна задача — один процесс).
5. Тесты: mock-агент по ACP + mock-cloud по протоколу.
