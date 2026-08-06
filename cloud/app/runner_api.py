"""The runner surface: the outbound-WS endpoint thin clients dial into,
plus the liveness plumbing around it (SaaS lastSeenAt reports and the
silent-connection watchdog)."""

from __future__ import annotations

import asyncio
import json
import logging
import time

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import config, deps
from . import protocol as p
from .chat_router import router as chats

api = APIRouter()
log = logging.getLogger("runner_api")


async def touch_runner(runner) -> None:
    """Throttled liveness report: refresh runners.lastSeenAt in the SaaS
    at most once per 5 minutes per runner."""
    now = time.monotonic()
    if runner.runner_id == 0 or now - runner.last_touch < 300:
        return
    runner.last_touch = now
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{config.OPENTAG_SAAS_URL}/api/trpc/runner.touch",
                json={"json": {"runnerId": runner.runner_id,
                               "secret": config.INTERNAL_API_SECRET}},
                headers={"x-internal-secret": config.INTERNAL_API_SECRET},
            )
    except Exception:
        log.warning("runner.touch failed for #%s", runner.runner_id)


async def runner_watchdog() -> None:
    """The runner pings every 25s; close connections silent for >90s so
    their handlers unregister and threads get the orphan notice."""
    while True:
        await asyncio.sleep(60)
        now = time.monotonic()
        for runner in list(chats.runners.values()):
            if now - runner.last_seen > 90:
                log.warning("runner ws=%s silent >90s, closing", runner.workspace_id)
                try:
                    await runner.ws.close(code=4008)
                except Exception:
                    pass


@api.websocket("/runner/v1")
async def runner_ws(ws: WebSocket):
    await ws.accept()
    # The handshake announces the client before it authenticates: a runner
    # rejected for a bad token still tells us which version and OS dialed in,
    # which is the whole question when a release starts failing to connect.
    hs_version = ws.headers.get("x-opentag-runner-version", "")
    hs_os = ws.headers.get("x-opentag-runner-os", "")
    log.info("runner dialed in: version=%s os=%s ua=%s",
             hs_version or "?", hs_os or "?",
             ws.headers.get("user-agent", "?"))
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
                # The frame stays authoritative; the handshake fills in when a
                # client sends the identity only in the headers.
                msg.runner_version = msg.runner_version or hs_version
                msg.os = msg.os or hs_os
                runner = await chats.register(ws, msg)
                if runner is None:
                    await ws.close(code=4001)
                    return
                continue
            if runner is None:
                await ws.send_text(p.encode(p.Error(code="not_authed",
                                                    message="send hello first")))
                continue

            runner.last_seen = time.monotonic()
            if isinstance(msg, p.Ping):
                await ws.send_text(p.encode(p.Pong()))
                await touch_runner(runner)
            elif isinstance(msg, p.TurnEvent):
                await chats.on_turn_event(msg, deps.renderer)
            elif isinstance(msg, p.TurnResult):
                await chats.on_turn_result(msg, deps.renderer)
    except WebSocketDisconnect:
        pass
    finally:
        if runner is not None:
            await chats.unregister(runner, deps.renderer)
