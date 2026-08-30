"""Launch the REAL `lohra dashboard` CLI against a loopback fake upstream.

Mirrors the T12 baseline's own harness pattern (eval-t12-baseline's
dash_launcher.py): registers an extra provider profile whose base_url
points at a fake upstream server, then invokes the public entry point
`lohra.cli.main(["dashboard", ...])`. No product file is read from or
written to; this script lives entirely under scripts/parity/gateway/ in
the TS candidate's own repo, never inside the read-only lohra/ checkout.
"""
from __future__ import annotations

import os
import sys

from lohra.providers.base import ProviderProfile, register_provider

FAKE = ProviderProfile(
    name="fakeprov",
    api_mode="chat_completions",
    display_name="Fake loopback",
    env_vars=("FAKE_API_KEY",),
    base_url=os.environ["FAKE_BASE_URL"],
    fallback_models=("fake-model-a", "fake-model-b"),
    default_max_tokens=8192,
)
register_provider(FAKE)

from lohra.cli import main  # noqa: E402

argv = ["dashboard", "--host", "127.0.0.1", "--port", os.environ["LOHRA_PORT"], "--no-input"]
if os.environ.get("LOHRA_NO_OPEN") == "1":
    argv.append("--no-open")
if os.environ.get("LOHRA_INSECURE") == "1":
    argv.append("--insecure")
# `dashboard` has no --provider flag; the active provider comes from the
# LOHRA_PROVIDER env var (already set by the launcher process), which the
# oracle's resolve.py honors ahead of any interactive wizard.
sys.exit(main(argv))
