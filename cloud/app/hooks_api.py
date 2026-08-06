"""The hooks surface — everything served publicly on hooks.opentag.farol.team.

These endpoints authenticate by request content (Slack signatures,
signed memory tokens), so they must be reached directly (caddy on the
VM): the Yandex API Gateway strips the custom headers they rely on.
The caddy vhost allowlists exactly these paths.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from . import config, deps
from .gateway import create_gateway_router

router = APIRouter()
router.include_router(create_gateway_router(config.OPENVIKING_URL,
                                            config.OPENVIKING_ROOT_KEY,
                                            config.INTERNAL_API_SECRET))


@router.post("/slack/events")
async def slack_events(request: Request):
    return await deps.slack_handler.handle(request)
