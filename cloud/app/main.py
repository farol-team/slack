"""Entry point: assembles the three surfaces of the data plane.

- hooks_api    — public, served via hooks.opentag.farol.team (caddy allowlist):
                 /slack/events, /memory/mcp. Authenticated by request
                 content (Slack signatures, signed memory tokens).
- runner_api   — /runner/v1 outbound-WS endpoint for thin clients.
- internal_api — /healthz + /internal/* (SaaS <-> cloud, shared secret).
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import deps
from .hooks_api import router as hooks
from .internal_api import api as internal
from .runner_api import api as runners, runner_watchdog

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    deps.ingestion.start()
    watchdog = asyncio.create_task(runner_watchdog())
    yield
    watchdog.cancel()
    await deps.ov_client.close()


app = FastAPI(title="OpenTag Cloud", version="0.1.0", lifespan=lifespan)
app.include_router(hooks)
app.include_router(runners)
app.include_router(internal)
