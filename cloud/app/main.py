"""Entry point: FastAPI app wiring everything together.

- WS endpoint for runners:  /runner/v1
- Slack Events + interactions: /slack/events
- Health: /healthz
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler

from . import protocol as p
from .memory import OpenVikingClient
from .gateway import create_gateway_router, mint_task_token
from .slack_app import (IngestionBuffer, SlackRenderer, create_bolt,
                        make_authorize, make_installation_resolver,
                        make_member_resolver, register_handlers)
from .importer import ImportManager
from .task_router import router

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")

# ---------- configuration ----------

SLACK_SIGNING_SECRET = os.environ["SLACK_SIGNING_SECRET"]
OPENVIKING_URL = os.getenv("OPENVIKING_URL", "http://openviking:1933")
OPENVIKING_ROOT_KEY = os.environ["OPENVIKING_ROOT_KEY"]
DEFAULT_CWD = os.getenv("DEFAULT_CWD", "/home/user/projects")
FAROL_SAAS_URL = os.environ["FAROL_SAAS_URL"].rstrip("/")  # SaaS control plane URL
# Public base URL of THIS service — agents reach /memory/mcp through it.
FAROL_CLOUD_PUBLIC_URL = os.environ["FAROL_CLOUD_PUBLIC_URL"].rstrip("/")
INTERNAL_API_SECRET = os.environ["INTERNAL_API_SECRET"]

# ---------- wiring ----------

ov_client = OpenVikingClient(OPENVIKING_URL, OPENVIKING_ROOT_KEY)
authorize_fn = make_authorize(FAROL_SAAS_URL, INTERNAL_API_SECRET)
resolve_installation = make_installation_resolver(FAROL_SAAS_URL, INTERNAL_API_SECRET)
resolve_member = make_member_resolver(FAROL_SAAS_URL, INTERNAL_API_SECRET,
                                      resolve_installation)


async def resolve_bot_token(team_id: str) -> str:
    return (await resolve_installation(team_id))["bot_token"]


async def resolve_ov_account(team_id: str) -> str:
    return (await resolve_installation(team_id))["ov_account_id"]


renderer = SlackRenderer(resolve_bot_token)
ingestion = IngestionBuffer(ov_client)
importer = ImportManager(ov_client, resolve_bot_token, resolve_ov_account)


def build_memory(account: str, user_key: str, channel: str) -> p.MemoryConfig:
    """Memory access for one task: our MCP gateway plus a signed token
    scoped to the task's channel archive (see gateway.py)."""
    token = mint_task_token(
        INTERNAL_API_SECRET, account, user_key,
        prefixes=[f"viking://resources/slack/{channel}/"])
    return p.MemoryConfig(mcp_url=f"{FAROL_CLOUD_PUBLIC_URL}/memory/mcp",
                          user_key=token)


bolt = create_bolt(SLACK_SIGNING_SECRET, authorize_fn)
register_handlers(bolt, renderer, ingestion, DEFAULT_CWD,
                  build_memory=build_memory,
                  resolve_installation=resolve_installation,
                  resolve_member=resolve_member)
slack_handler = AsyncSlackRequestHandler(bolt)


@asynccontextmanager
async def lifespan(app: FastAPI):
    ingestion.start()
    yield
    await ov_client.close()


app = FastAPI(title="Farol Cloud", version="0.1.0", lifespan=lifespan)
app.include_router(create_gateway_router(OPENVIKING_URL, OPENVIKING_ROOT_KEY,
                                         INTERNAL_API_SECRET))


@app.get("/healthz")
async def healthz():
    return {"ok": True, "runners": len(router.runners), "tasks": len(router.tasks)}


@app.post("/slack/events")
async def slack_events(request: Request):
    return await slack_handler.handle(request)


# ---------- internal API (SaaS <-> cloud, shared-secret guarded) ----------

def check_internal(request: Request) -> None:
    if not INTERNAL_API_SECRET or \
            request.headers.get("x-internal-secret") != INTERNAL_API_SECRET:
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="unauthorized")


@app.post("/internal/provision")
async def provision(request: Request):
    """Create the OpenViking account for a freshly installed workspace.
    Called by the SaaS after the Slack OAuth callback; idempotent."""
    check_internal(request)
    body = await request.json()
    team_id = body.get("team_id")
    if not team_id:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="team_id required")
    account = await resolve_ov_account(team_id)
    result = await ov_client.create_account(account)
    return {"ok": True, "account": account,
            "existing": bool(result.get("existing"))}


@app.post("/internal/import/start")
async def import_start(request: Request):
    check_internal(request)
    body = await request.json()
    team_id = body.get("team_id")
    if not team_id:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="team_id required")
    job = await importer.start(team_id)
    return {"state": job.state, "team_id": team_id}


@app.get("/internal/import/{team_id}/status")
async def import_status(team_id: str, request: Request):
    check_internal(request)
    job = importer.status(team_id)
    if job is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="no import for this team")
    return {
        "state": job.state,
        "total_channels": job.total_channels,
        "channels_done": job.channels_done,
        "messages_imported": job.messages_imported,
        "current_channel": job.current_channel,
        "error": job.error,
        "elapsed_secs": int(__import__("time").time() - job.started_at),
    }


@app.websocket("/runner/v1")
async def runner_ws(ws: WebSocket):
    await ws.accept()
    runner = None
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = p.parse_runner_message(json.loads(raw))
            except (ValueError, json.JSONDecodeError) as e:
                await ws.send_text(p.encode(p.Error(code="bad_frame", message=str(e))))
                continue

            if isinstance(msg, p.Hello):
                runner = await router.register(ws, msg)
                if runner is None:
                    await ws.close(code=4001)
                    return
            elif runner is None:
                await ws.send_text(p.encode(p.Error(code="not_authed",
                                                    message="send hello first")))
            elif isinstance(msg, p.Ping):
                await ws.send_text(p.encode(p.Pong()))
            elif isinstance(msg, p.TaskEvent):
                await router.on_task_event(msg, renderer)
            elif isinstance(msg, p.TaskResult):
                await router.on_task_result(msg, renderer)
    except WebSocketDisconnect:
        pass
    finally:
        if runner is not None:
            router.unregister(runner)
