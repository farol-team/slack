"""Environment configuration. Import-time fail-fast: required variables
raise KeyError at startup rather than midway through a request."""

from __future__ import annotations

import os

SLACK_SIGNING_SECRET = os.environ["SLACK_SIGNING_SECRET"]
OPENVIKING_URL = os.getenv("OPENVIKING_URL", "http://openviking:1933")
OPENVIKING_ROOT_KEY = os.environ["OPENVIKING_ROOT_KEY"]
DEFAULT_CWD = os.getenv("DEFAULT_CWD", "/home/user/projects")
FAROL_SAAS_URL = os.environ["FAROL_SAAS_URL"].rstrip("/")  # SaaS control plane
# Public base URL of the hooks surface — agents reach /memory/mcp through it.
FAROL_CLOUD_PUBLIC_URL = os.environ["FAROL_CLOUD_PUBLIC_URL"].rstrip("/")
INTERNAL_API_SECRET = os.environ["INTERNAL_API_SECRET"]
