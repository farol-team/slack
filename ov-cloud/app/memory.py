"""Thin async client for the OpenViking HTTP API.

OpenViking handles multi-tenancy natively (account_id scoping):
- account  == Slack workspace
- resources/ are shared inside the account
- user/{id}/memories are per-user

Docs: https://docs.openviking.ai — endpoints used below follow the
server deployment API (v1). Adjust paths if your version differs.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

log = logging.getLogger("openviking")


class OpenVikingClient:
    def __init__(self, base_url: str, root_key: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"X-API-Key": root_key},
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    # ---------- provisioning ----------

    async def create_account(self, account_id: str, admin_user_id: str = "slack-bot") -> dict:
        """Create a tenant account when a workspace installs the Slack app."""
        res = await self._client.post("/api/v1/admin/accounts", json={
            "account_id": account_id,
            "admin_user_id": admin_user_id,
        })
        res.raise_for_status()
        return res.json()

    async def register_user(self, account_id: str, user_id: str) -> dict:
        """Register a Slack user inside the account; returns their API key
        which the runner uses as its memory identity."""
        res = await self._client.post(
            f"/api/v1/admin/accounts/{account_id}/users",
            json={"user_id": user_id})
        res.raise_for_status()
        return res.json()

    # ---------- ingestion ----------

    async def add_resource(self, account_id: str, content: str, path: str,
                           reason: str = "", wait: bool = False) -> dict:
        """Write a batch of Slack messages as a resource document.
        OpenViking auto-generates L0/L1 tiers after ingestion."""
        res = await self._client.post("/api/v1/resources", json={
            "account_id": account_id,
            "to": f"/{account_id}/{path}",
            "content": content,
            "reason": reason,
            "wait": wait,
        })
        res.raise_for_status()
        return res.json()

    # ---------- retrieval (used by dashboard / debugging) ----------

    async def find(self, account_id: str, query: str,
                   target_uri: Optional[str] = None, limit: int = 10) -> dict[str, Any]:
        res = await self._client.post("/api/v1/search/find", json={
            "account_id": account_id,
            "query": query,
            "target_uri": target_uri or f"/{account_id}/resources/",
            "limit": limit,
        })
        res.raise_for_status()
        return res.json()

    # ---------- sessions -> memory ----------

    async def commit_session(self, account_id: str, user_id: str,
                             messages: list[dict]) -> dict:
        """Commit a finished Slack thread as a session so OpenViking
        extracts long-term memories (preferences, events, patterns)."""
        res = await self._client.post("/api/v1/sessions/commit", json={
            "account_id": account_id,
            "user_id": user_id,
            "messages": messages,
        })
        res.raise_for_status()
        return res.json()
