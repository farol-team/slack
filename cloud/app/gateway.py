"""Memory gateway: the agent-facing MCP endpoint.

OpenViking has no per-path ACL inside an account's shared resources, so
channel scoping is enforced here: the cloud mints a signed task token
whose payload pins the OV account, the member's user id and the allowed
`viking://` prefixes; the gateway validates it on every request and
proxies MCP JSON-RPC to OpenViking in trusted mode (identity injected
via X-OpenViking-* headers, never taken from the client). Any tool call
whose target URI falls outside the allowed prefixes is rejected, so the
agent keeps the native OpenViking MCP surface but physically cannot
reach another channel's memory.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from uuid import UUID
import logging
import time
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

log = logging.getLogger("gateway")

TOKEN_PREFIX = "fmt_"          # Farol memory token
TOKEN_TTL_SECS = 12 * 3600

# Tools that never touch shared resources (user-scoped or diagnostic).
USER_SCOPED_TOOLS = {"remember", "recall", "health"}
# Tools whose URI argument must stay inside the allowed prefixes.
URI_TOOLS = {"find", "search", "read", "list", "grep", "glob"}
# Everything else (forget, add_resource, watches, …) is denied: the
# write path into shared memory is ingestion/commit, not the agent.


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def mint_task_token(secret: str, account: str, user: str,
                    prefixes: list[str], ttl_secs: int = TOKEN_TTL_SECS) -> str:
    payload = {"a": account, "u": user, "p": prefixes,
               "exp": int(time.time()) + ttl_secs}
    raw = _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64(hmac.new(secret.encode(), raw.encode(), hashlib.sha256).digest())
    return f"{TOKEN_PREFIX}{raw}.{sig}"


def verify_task_token(secret: str, token: str) -> Optional[dict]:
    if not token.startswith(TOKEN_PREFIX):
        return None
    try:
        raw, sig = token[len(TOKEN_PREFIX):].split(".", 1)
    except ValueError:
        return None
    expected = _b64(hmac.new(secret.encode(), raw.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        payload = json.loads(_unb64(raw))
    except (ValueError, json.JSONDecodeError):
        return None
    if payload.get("exp", 0) < time.time():
        return None
    return payload


def _within(uri: Any, prefixes: list[str]) -> bool:
    return (isinstance(uri, str) and ".." not in uri
            and any(uri.startswith(p) for p in prefixes))


def check_scope(body: dict, prefixes: list[str]) -> tuple[bool, str]:
    """Scope-check (and possibly rewrite in place) one JSON-RPC message.
    Non-tool-call messages (initialize, tools/list, notifications) pass."""
    if body.get("method") != "tools/call":
        return True, ""
    params = body.get("params") or {}
    tool = params.get("name") or ""
    args = params.setdefault("arguments", {})

    if tool in USER_SCOPED_TOOLS:
        return True, ""

    if tool in {"find", "search"}:
        target = args.get("target_uri")
        if not target:
            # No target means account-wide search — pin it to the scope.
            args["target_uri"] = prefixes[0]
            return True, ""
        return (True, "") if _within(target, prefixes) else \
            (False, f"target_uri outside memory scope: {target}")

    if tool == "read":
        uris = args.get("uris")
        uris = [uris] if isinstance(uris, str) else (uris or [])
        bad = [u for u in uris if not _within(u, prefixes)]
        return (False, f"uri outside memory scope: {bad[0]}") if bad else (True, "")

    if tool in URI_TOOLS:  # list, grep, glob
        uri = args.get("uri")
        if not uri:
            args["uri"] = prefixes[0]
            return True, ""
        return (True, "") if _within(uri, prefixes) else \
            (False, f"uri outside memory scope: {uri}")

    return False, f"tool not allowed through the memory gateway: {tool}"


def create_gateway_router(ov_url: str, ov_root_key: str, secret: str) -> APIRouter:
    router = APIRouter()
    upstream = f"{ov_url.rstrip('/')}/mcp"

    @router.api_route("/memory/mcp", methods=["GET", "POST", "DELETE"])
    async def memory_mcp(request: Request):
        token = (request.headers.get("authorization") or "")
        token = token.removeprefix("Bearer ").strip()
        scope = verify_task_token(secret, token)
        if scope is None:
            return JSONResponse({"error": "invalid or expired memory token"},
                                status_code=401)

        content: Optional[bytes] = None
        if request.method == "POST":
            try:
                body = json.loads(await request.body())
            except json.JSONDecodeError:
                return JSONResponse({"error": "invalid JSON"}, status_code=400)
            if isinstance(body, list):  # batches: all-or-nothing
                verdicts = [check_scope(m, scope["p"]) for m in body]
                denied = [r for ok, r in verdicts if not ok]
            else:
                ok, reason = check_scope(body, scope["p"])
                denied = [] if ok else [reason]
            if denied:
                log.warning("scope denial for %s/%s: %s",
                            scope["a"], scope["u"], denied[0])
                rpc_id = body.get("id") if isinstance(body, dict) else None
                return JSONResponse({"jsonrpc": "2.0", "id": rpc_id,
                                     "error": {"code": -32001,
                                               "message": denied[0]}})
            content = json.dumps(body).encode()

        headers = {
            "X-API-Key": ov_root_key,
            "X-OpenViking-Account": scope["a"],
            "X-OpenViking-User": scope["u"],
        }
        for h in ("content-type", "accept", "mcp-session-id",
                  "last-event-id", "mcp-protocol-version"):
            if h in request.headers:
                headers[h] = request.headers[h]

        client = httpx.AsyncClient(timeout=httpx.Timeout(30, read=None))
        req = client.build_request(request.method, upstream,
                                   headers=headers, content=content)
        try:
            resp = await client.send(req, stream=True)
        except httpx.HTTPError as e:
            await client.aclose()
            log.exception("memory upstream unreachable")
            return JSONResponse({"error": f"memory upstream: {e}"},
                                status_code=502)

        async def relay():
            try:
                async for chunk in resp.aiter_raw():
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        passthrough = {
            k: v for k, v in resp.headers.items()
            if k.lower() in ("content-type", "mcp-session-id", "cache-control")
        }
        if resp.status_code == 204:
            await resp.aclose()
            await client.aclose()
            return Response(status_code=204, headers=passthrough)
        return StreamingResponse(relay(), status_code=resp.status_code,
                                 headers=passthrough)

    @router.get("/files/{turn_id}/{index}")
    async def turn_file(turn_id: str, index: int, request: Request):
        """Hand the runner a file the asking message carried. Slack's
        `url_private` needs the bot token, which must never leave this
        service — so the runner asks here, with the task token it already
        holds for memory, and the scope check is the same one."""
        token = (request.headers.get("authorization") or "")
        token = token.removeprefix("Bearer ").strip()
        scope = verify_task_token(secret, token)
        if scope is None:
            return JSONResponse({"error": "invalid or expired task token"},
                                status_code=401)

        from .chat_router import router as chat_router
        from .deps import resolve_installation
        turn = chat_router.turns.get(UUID(turn_id)) if _is_uuid(turn_id) else None
        if turn is None or index >= len(turn.attachments):
            return JSONResponse({"error": "no such attachment"}, status_code=404)
        # The token is scoped to an account; a turn of another tenant is not
        # this caller's to read, however valid their token is.
        if turn.chat.workspace_id != scope.get("a"):
            return JSONResponse({"error": "not your turn"}, status_code=403)

        att = turn.attachments[index]
        inst = await resolve_installation(att["team_id"])
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            res = await client.get(
                att["url_private"],
                headers={"Authorization": f"Bearer {inst['bot_token']}"})
        if res.status_code != 200:
            return JSONResponse({"error": "slack refused the file"},
                                status_code=502)
        return Response(content=res.content, media_type=att["mime"])

    return router


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
        return True
    except ValueError:
        return False
