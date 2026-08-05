"""The ops surface: health and the SaaS <-> cloud internal API
(shared-secret guarded). Not exposed on hooks.farol.team."""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request

from . import config, deps
from .chat_router import router as chats

api = APIRouter()


@api.get("/healthz")
async def healthz():
    return {"ok": True, "runners": len(chats.runners), "turns": len(chats.turns)}


def check_internal(request: Request) -> None:
    if not config.INTERNAL_API_SECRET or \
            request.headers.get("x-internal-secret") != config.INTERNAL_API_SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")


@api.post("/internal/provision")
async def provision(request: Request):
    """Create the OpenViking account for a freshly installed workspace.
    Called by the SaaS after the Slack OAuth callback; idempotent."""
    check_internal(request)
    body = await request.json()
    team_id = body.get("team_id")
    if not team_id:
        raise HTTPException(status_code=400, detail="team_id required")
    account = await deps.resolve_ov_account(team_id)
    result = await deps.ov_client.create_account(account)
    return {"ok": True, "account": account,
            "existing": bool(result.get("existing"))}


@api.post("/internal/import/start")
async def import_start(request: Request):
    check_internal(request)
    body = await request.json()
    team_id = body.get("team_id")
    if not team_id:
        raise HTTPException(status_code=400, detail="team_id required")
    job = await deps.importer.start(team_id)
    return {"state": job.state, "team_id": team_id}


@api.get("/internal/import/{team_id}/status")
async def import_status(team_id: str, request: Request):
    check_internal(request)
    job = deps.importer.status(team_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no import for this team")
    return {
        "state": job.state,
        "total_channels": job.total_channels,
        "channels_done": job.channels_done,
        "messages_imported": job.messages_imported,
        "current_channel": job.current_channel,
        "error": job.error,
        "elapsed_secs": int(time.time() - job.started_at),
    }
