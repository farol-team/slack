"""Shared singletons wired once per process. Surfaces (hooks_api,
runner_api, internal_api) import from here; nothing here imports them."""

from __future__ import annotations

from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler

from . import config
from . import protocol as p
from .gateway import mint_task_token
from .importer import ImportManager
from .memory import OpenVikingClient
from .slack_app import (IngestionBuffer, SlackRenderer, create_bolt,
                        make_authorize, make_installation_resolver,
                        make_member_resolver, register_handlers)

ov_client = OpenVikingClient(config.OPENVIKING_URL, config.OPENVIKING_ROOT_KEY)
authorize_fn = make_authorize(config.FAROL_SAAS_URL, config.INTERNAL_API_SECRET)
resolve_installation = make_installation_resolver(config.FAROL_SAAS_URL,
                                                  config.INTERNAL_API_SECRET)
resolve_member = make_member_resolver(config.FAROL_SAAS_URL,
                                      config.INTERNAL_API_SECRET,
                                      resolve_installation)


async def resolve_bot_token(team_id: str) -> str:
    return (await resolve_installation(team_id))["bot_token"]


async def resolve_ov_account(team_id: str) -> str:
    return (await resolve_installation(team_id))["ov_account_id"]


renderer = SlackRenderer(resolve_bot_token)
ingestion = IngestionBuffer(ov_client)
importer = ImportManager(ov_client, resolve_bot_token, resolve_ov_account)


def build_memory(account: str, user_key: str, channel: str) -> p.MemoryConfig:
    """Memory access for one turn: our MCP gateway plus a signed token
    scoped to the turn's channel archive (see gateway.py)."""
    token = mint_task_token(
        config.INTERNAL_API_SECRET, account, user_key,
        prefixes=[f"viking://resources/slack/{channel}/"])
    return p.MemoryConfig(mcp_url=f"{config.FAROL_CLOUD_PUBLIC_URL}/memory/mcp",
                          user_key=token)


bolt = create_bolt(config.SLACK_SIGNING_SECRET, authorize_fn)
register_handlers(bolt, renderer, ingestion, config.DEFAULT_CWD,
                  build_memory=build_memory,
                  resolve_installation=resolve_installation,
                  resolve_member=resolve_member)
slack_handler = AsyncSlackRequestHandler(bolt)
