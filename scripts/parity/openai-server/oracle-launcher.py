"""Launch the REAL `lohra serve` CLI against a loopback fake upstream.

Copied from the T11 baseline (`eval-t11-baseline/harness-serve_launcher.py`)
and parameterized for the parity harness: registers an extra `fakeprov`
ProviderProfile whose base_url points at the loopback fake-upstream server, so
every provider call the oracle makes during a scenario lands on OUR fixture,
never a real network. No product file is touched; the entry point is
`lohra.cli.main(["serve", ...])`, exactly as `run_openai_server` would invoke
it from the real CLI.
"""
from __future__ import annotations

import os
import sys

from lohra.providers.base import ProviderProfile, register_provider

FALLBACK_MODELS = () if os.environ.get("LOHRA_T11_EMPTY_MODELS") == "1" else ("fake-model-a", "fake-model-b")

FAKE = ProviderProfile(
    name="fakeprov",
    api_mode="chat_completions",
    display_name="Fake loopback",
    env_vars=("FAKE_API_KEY",),
    base_url=os.environ["FAKE_BASE_URL"],
    fallback_models=FALLBACK_MODELS,
    default_max_tokens=8192,
)
register_provider(FAKE)

from lohra.cli import main  # noqa: E402

argv = ["serve", "--host", "127.0.0.1", "--port", os.environ["LOHRA_PORT"]]
if os.environ.get("LOHRA_INSECURE") == "1":
    argv.append("--insecure")
tools = os.environ.get("LOHRA_TOOLS", "")
if tools:
    argv += ["--tools", tools]
sys.exit(main(argv))
