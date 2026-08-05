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


@api.post("/internal/memory/stats")
async def memory_stats(request: Request):
    """Aggregate the workspace's Slack memory: per-channel archive files
    and sizes straight from the OpenViking filesystem."""
    check_internal(request)
    body = await request.json()
    team_id = body.get("team_id")
    if not team_id:
        raise HTTPException(status_code=400, detail="team_id required")
    account = await deps.resolve_ov_account(team_id)

    channels = []
    total_files = 0
    total_bytes = 0
    last_modified: str | None = None
    try:
        roots = await deps.ov_client.ls(account, "farol-dashboard",
                                        "viking://resources/slack/")
    except Exception:
        roots = []
    for entry in roots[:100]:
        if not entry.get("isDir"):
            continue
        uri = entry["uri"]
        try:
            files = await deps.ov_client.ls(account, "farol-dashboard", uri)
        except Exception:
            continue
        docs = [f for f in files if not f.get("isDir")]
        size = sum(int(f.get("size") or 0) for f in docs)
        newest = max((f.get("modTime") or "" for f in docs), default="")
        total_files += len(docs)
        total_bytes += size
        if newest and (last_modified is None or newest > last_modified):
            last_modified = newest
        channels.append({
            "channelId": uri.rstrip("/").rsplit("/", 1)[-1],
            "files": len(docs), "bytes": size, "lastModified": newest or None,
        })
    channels.sort(key=lambda c: c["bytes"], reverse=True)
    return {"account": account, "channels": channels,
            "totalFiles": total_files, "totalBytes": total_bytes,
            "lastModified": last_modified}


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
