"""Thin async client for the OpenViking HTTP API, trusted mode.

The OV server runs with `auth_mode = "trusted"`: this service is the
identity-injecting gateway, so every tenant-scoped call carries the
root key plus `X-OpenViking-Account` / `X-OpenViking-User` headers.
Tenancy: account == Slack workspace (ovAccountId), user == member's
memory identity (ovUserKey) or a service identity for system writes.

Docs: OpenViking guides/04-authentication.md (trusted mode),
concepts/11-multi-tenant.md.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

log = logging.getLogger("openviking")

# Service identity for writes not attributable to a member.
INGEST_USER = "farol-ingest"


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

    @staticmethod
    def _tenant(account_id: str, user_id: str) -> dict[str, str]:
        return {"X-OpenViking-Account": account_id, "X-OpenViking-User": user_id}

    # ---------- provisioning (Admin API, root only) ----------

    async def create_account(self, account_id: str,
                             admin_user_id: str = "farol-admin") -> dict:
        """Create the tenant account when a workspace installs the Slack app.
        Idempotent for callers: an already-existing account is not an error."""
        res = await self._client.post("/api/v1/admin/accounts", json={
            "account_id": account_id,
            "admin_user_id": admin_user_id,
        })
        if res.status_code in (400, 409):
            log.info("account %s already exists (%s)", account_id, res.status_code)
            return {"account_id": account_id, "existing": True}
        res.raise_for_status()
        return res.json()

    # ---------- ingestion ----------

    async def add_resource(self, account_id: str, content: str, path: str,
                           reason: str = "", wait: bool = False,
                           user_id: str = INGEST_USER) -> dict:
        """Append a batch of Slack messages to a channel's day file.
        `path` is relative to the account, e.g. `resources/slack/C123/2026-08-05.md`.

        Plain text goes through `content/write` (`/api/v1/resources` is the
        URL/file importer and rejects inline content): `append` for an
        existing file, `create` on 404 (parents auto-created), and back to
        `append` if we lose the creation race (409). Verified against
        OpenViking v0.4.12."""
        if not content.endswith("\n"):
            content += "\n"
        headers = self._tenant(account_id, user_id)

        async def write(mode: str) -> httpx.Response:
            return await self._client.post(
                "/api/v1/content/write",
                json={"uri": f"viking://{path}", "content": content,
                      "mode": mode, "wait": wait},
                headers=headers,
            )

        res = await write("append")
        if res.status_code == 404:
            res = await write("create")
            if res.status_code == 409:
                res = await write("append")
        res.raise_for_status()
        return res.json()

    async def import_file(self, account_id: str, name: str, content: bytes,
                          mime: str, dest_dir: str,
                          user_id: str = INGEST_USER,
                          reason: str = "") -> Optional[str]:
        """Hand a shared file to OpenViking and file it under `dest_dir`.

        OpenViking does the reading: the importer runs semantic extraction and
        embeddings, and media through the VLM — a PDF or a screenshot becomes
        searchable content rather than a line saying one existed.

        It always lands the import at `viking://resources/<file stem>`, which
        no parameter moves, and that path is outside the channel scope an
        agent's token carries. So the file is uploaded under a name unique to
        it (the Slack file id), then moved with WebDAV into the channel's own
        directory. Returns the final uri, or None when the import failed."""
        headers = self._tenant(account_id, user_id)

        upload = await self._client.post(
            "/api/v1/resources/temp_upload",
            files={"file": (name, content, mime or "application/octet-stream")},
            headers=headers,
        )
        upload.raise_for_status()
        temp_id = (upload.json().get("result") or {}).get("temp_file_id")
        if not temp_id:
            log.warning("temp_upload returned no id for %s", name)
            return None

        imported = await self._client.post(
            "/api/v1/resources",
            json={"temp_file_id": temp_id, "wait": True,
                  "reason": reason or f"file shared in Slack: {name}"},
            headers=headers,
            timeout=180.0,
        )
        imported.raise_for_status()
        root_uri = (imported.json().get("result") or {}).get("root_uri")
        if not root_uri:
            log.warning("import returned no root_uri for %s", name)
            return None

        # The channel directory exists (day files live there); its `files`
        # collection may not. 405 means it already does.
        mkcol = await self._client.request(
            "MKCOL", f"/webdav/{dest_dir}", headers=headers)
        if mkcol.status_code not in (200, 201, 405):
            log.warning("MKCOL %s -> %s", dest_dir, mkcol.status_code)

        leaf = root_uri.rsplit("/", 1)[-1]
        source = "/webdav/" + root_uri.removeprefix("viking://")
        dest = f"/webdav/{dest_dir}/{leaf}"
        moved = await self._client.request(
            "MOVE", source, headers={**headers, "Destination": dest})
        if moved.status_code not in (200, 201, 204):
            log.warning("MOVE %s -> %s: %s", source, dest, moved.status_code)
            return root_uri
        return f"viking://{dest_dir}/{leaf}"

    async def delete_uri(self, account_id: str, uri: str,
                         user_id: str = INGEST_USER) -> bool:
        """Remove a resource — what Slack forgets, memory forgets too."""
        path = uri.removeprefix("viking://")
        res = await self._client.request(
            "DELETE", f"/webdav/{path}", headers=self._tenant(account_id, user_id))
        return res.status_code in (200, 204, 404)

    # ---------- filesystem (dashboard stats) ----------

    async def ls(self, account_id: str, user_id: str, uri: str) -> list[dict]:
        """List one directory level of the account's viking filesystem."""
        res = await self._client.get(
            "/api/v1/fs/ls", params={"uri": uri},
            headers=self._tenant(account_id, user_id),
        )
        res.raise_for_status()
        return res.json().get("result") or []

    # ---------- retrieval (dashboard / debugging) ----------

    async def status(self) -> bool:
        """True when the OV server answers its health endpoint
        (`/health`, verified against OpenViking v0.4.12)."""
        try:
            res = await self._client.get("/health")
            return res.is_success
        except httpx.HTTPError:
            return False

    async def find(self, account_id: str, user_id: str, query: str,
                   target_uri: str = "viking://resources/",
                   limit: int = 10) -> list[dict]:
        """Semantic search over the account's memory."""
        res = await self._client.post(
            "/api/v1/search/find",
            json={"query": query, "target_uri": target_uri, "limit": limit},
            headers=self._tenant(account_id, user_id),
        )
        res.raise_for_status()
        found = res.json().get("result") or {}
        if isinstance(found, list):        # older shape, kept for safety
            return found
        # OpenViking answers with an envelope — {memories, resources, skills,
        # total} — and the callers of this want hits. Returning the envelope
        # made the dashboard render nothing at all: it maps over an array, and
        # an object has no `.map` and no `.length` to report emptiness with.
        hits: list[dict] = []
        for bucket in ("resources", "memories", "skills"):
            hits.extend(found.get(bucket) or [])
        hits.sort(key=lambda h: h.get("score") or 0, reverse=True)
        return hits

