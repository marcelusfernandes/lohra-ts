"""Launch the REAL `lohra dashboard` CLI against a loopback fake upstream, so
its background cron scheduler is the real scheduler.py thread, not a stub.
Same pattern as T11's oracle-launcher.py (register a `fakeprov` provider
before `main()`), adapted for `dashboard` instead of `serve`: `--no-open`
(never open a browser on the host machine) and an ephemeral `--port`.
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
    fallback_models=("fake-model-a",),
    default_max_tokens=8192,
)
register_provider(FAKE)

from lohra.cli import main  # noqa: E402

argv = ["dashboard", "--host", "127.0.0.1", "--port", os.environ["LOHRA_PORT"], "--no-open", "--insecure"]
sys.exit(main(argv))
