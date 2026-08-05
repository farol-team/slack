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


@api.get("/internal/channels/{team_id}")
async def list_channels(team_id: str, request: Request):
    """Public channels of a workspace, with whether the bot is in them.
    The dashboard shows this; the bot token never leaves the cloud."""
    check_internal(request)
    from slack_sdk.web.async_client import AsyncWebClient
    token = await deps.resolve_bot_token(team_id)
    client = AsyncWebClient(token=token)
    out, cursor = [], None
    # One page is 200 channels; two pages is enough for any team that has
    # not made channel sprawl its hobby, and keeps the dashboard snappy.
    for _ in range(2):
        res = await client.conversations_list(
            types="public_channel", exclude_archived=True, limit=200,
            cursor=cursor)
        for ch in res.get("channels", []):
            out.append({"id": ch["id"], "name": ch.get("name", ""),
                        "is_member": bool(ch.get("is_member"))})
        cursor = (res.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            break
    out.sort(key=lambda c: (not c["is_member"], c["name"]))
    return {"channels": out}


@api.post("/internal/channels/{team_id}/join")
async def join_channel(team_id: str, request: Request):
    """Put the bot in a channel without anyone typing /invite."""
    check_internal(request)
    body = await request.json()
    channel = body.get("channel_id")
    if not channel:
        raise HTTPException(status_code=400, detail="channel_id required")
    from slack_sdk.web.async_client import AsyncWebClient
    client = AsyncWebClient(token=await deps.resolve_bot_token(team_id))
    try:
        await client.conversations_join(channel=channel)
    except Exception as e:
        # already_in_channel is success as far as the caller is concerned.
        if "already_in_channel" not in str(e):
            raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


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


@api.post("/internal/memory/status")
async def memory_status(request: Request):
    """Liveness of the OpenViking server, for the dashboard badge.
    The SaaS has no direct OV route — we answer on its behalf."""
    check_internal(request)
    return {"online": await deps.ov_client.status()}


@api.post("/internal/memory/search")
async def memory_search(request: Request):
    """Semantic search over the workspace memory, proxied for the
    dashboard (agents get the same via the MCP gateway)."""
    check_internal(request)
    body = await request.json()
    team_id = body.get("team_id")
    query = body.get("query")
    if not team_id or not query:
        raise HTTPException(status_code=400, detail="team_id and query required")
    account = await deps.resolve_ov_account(team_id)
    results = await deps.ov_client.find(
        account, "farol-dashboard", query,
        target_uri=body.get("scope") or "viking://resources/",
        limit=int(body.get("limit") or 10),
    )
    return {"results": results}


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
