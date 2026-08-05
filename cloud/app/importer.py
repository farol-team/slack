"""Historical import: pull conversations.history per channel and write
day-batched markdown archives into OpenViking.

Runs as background asyncio tasks, one job per Slack team. Progress is
kept in memory (MVP) and exposed via /internal/import/{team_id}/status.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from slack_sdk.web.async_client import AsyncWebClient

from .memory import OpenVikingClient

log = logging.getLogger("importer")

# Slack rate limits: conversations.history ~50+ req/min on special tier;
# keep a polite pause between pages.
PAGE_PAUSE_SECS = 1.2
CHANNEL_PAUSE_SECS = 2.0


@dataclass
class ImportJob:
    team_id: str
    ov_account_id: str
    state: str = "running"          # running | done | failed
    total_channels: int = 0
    channels_done: int = 0
    messages_imported: int = 0
    current_channel: str = ""
    error: Optional[str] = None
    started_at: float = field(default_factory=time.time)


class ImportManager:
    def __init__(
        self,
        ov: OpenVikingClient,
        token_resolver: Callable[[str], Awaitable[str]],
        account_resolver: Callable[[str], Awaitable[str]],
    ) -> None:
        self.ov = ov
        self.resolve_token = token_resolver
        self.resolve_account = account_resolver
        self.jobs: dict[str, ImportJob] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def status(self, team_id: str) -> Optional[ImportJob]:
        return self.jobs.get(team_id)

    async def start(self, team_id: str) -> ImportJob:
        existing = self.jobs.get(team_id)
        if existing and existing.state == "running":
            return existing

        token = await self.resolve_token(team_id)
        account = await self.resolve_account(team_id)
        job = ImportJob(team_id=team_id, ov_account_id=account)
        self.jobs[team_id] = job
        self._tasks[team_id] = asyncio.create_task(self._run(job, token))
        return job

    async def _run(self, job: ImportJob, token: str) -> None:
        client = AsyncWebClient(token=token)
        user_cache: dict[str, str] = {}

        async def user_name(uid: str) -> str:
            if uid not in user_cache:
                try:
                    res = await client.users_info(user=uid)
                    user_cache[uid] = res["user"].get("real_name") or res["user"].get("name", uid)
                except Exception:
                    user_cache[uid] = uid
            return user_cache[uid]

        try:
            # Channels where the bot is a member.
            channels: list[dict] = []
            cursor = None
            while True:
                res = await client.conversations_list(
                    limit=200, types="public_channel,private_channel",
                    **({"cursor": cursor} if cursor else {}),
                )
                channels.extend(c for c in res.get("channels", []) if c.get("is_member"))
                cursor = res.get("response_metadata", {}).get("next_cursor")
                if not cursor:
                    break

            job.total_channels = len(channels)
            log.info("import %s: %d channels", job.team_id, job.total_channels)

            for ch in channels:
                job.current_channel = ch["name"]
                try:
                    await self._import_channel(job, client, ch, user_name)
                except Exception:
                    log.exception("import %s: channel %s failed", job.team_id, ch["name"])
                job.channels_done += 1
                await asyncio.sleep(CHANNEL_PAUSE_SECS)

            job.state = "done"
            log.info("import %s done: %d messages", job.team_id, job.messages_imported)
        except Exception as e:
            job.state = "failed"
            job.error = str(e)
            log.exception("import %s failed", job.team_id)

    async def _import_channel(self, job: ImportJob, client: AsyncWebClient,
                              ch: dict, user_name) -> None:
        """Page through history oldest-first, group by day, flush each day
        as one OpenViking resource."""
        by_day: dict[str, list[str]] = defaultdict(list)
        cursor = None

        while True:
            res = await client.conversations_history(
                channel=ch["id"], limit=200,
                **({"cursor": cursor} if cursor else {}),
            )
            messages = res.get("messages", [])
            for m in reversed(messages):  # API returns newest-first
                if m.get("subtype") or m.get("bot_id"):
                    continue
                ts = m.get("ts", "0")
                day = time.strftime("%Y-%m-%d", time.gmtime(float(ts)))
                user = await user_name(m.get("user", "?"))
                text = (m.get("text") or "").replace("\n", " ")
                by_day[day].append(f"[{ts}] {user}: {text}")
                job.messages_imported += 1

            cursor = res.get("response_metadata", {}).get("next_cursor")
            if not cursor:
                break
            await asyncio.sleep(PAGE_PAUSE_SECS)

        # Flush day batches (append-style: one resource per channel-day).
        # Keyed by channel ID, matching live ingestion and the per-channel
        # memory scope enforced by the gateway.
        for day, lines in sorted(by_day.items()):
            content = f"# #{ch['name']} — {day}\n\n" + "\n".join(lines)
            try:
                await self.ov.add_resource(
                    account_id=job.ov_account_id,
                    content=content,
                    path=f"resources/slack/{ch['id']}/{day}.md",
                    reason=f"Slack #{ch['name']} history import",
                )
            except Exception:
                log.exception("flush failed #%s %s (%d lines)", ch["name"], day, len(lines))

        log.info("import %s: #%s — %d days, total %d msgs",
                 job.team_id, ch["name"], len(by_day), job.messages_imported)
