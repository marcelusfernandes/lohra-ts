"""Register the loopback provider and launch the real pinned oracle CLI."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys

from lohra.providers.base import ProviderProfile, register_provider

register_provider(ProviderProfile(
    name="fakeprov",
    api_mode="chat_completions",
    display_name="T19 loopback fixture",
    env_vars=("FAKE_API_KEY",),
    base_url=os.environ["FAKE_BASE_URL"],
    fallback_models=("fake-model-a", "fake-model-b"),
    default_max_tokens=8192,
))

fixture_path = Path(__file__).with_name("oracle-mcp-fixture.py")
spec = importlib.util.spec_from_file_location("t19_oracle_mcp_fixture", fixture_path)
if spec is None or spec.loader is None:
    raise RuntimeError("could not load the T19 oracle MCP fixture")
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)
fixture_module.install()

from lohra.cli import main  # noqa: E402

sys.exit(main(json.loads(os.environ["LOHRA_ARGV"])))
