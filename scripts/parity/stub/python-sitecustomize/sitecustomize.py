"""Harness-only redirect from frozen local endpoints to the active parity stub."""

from __future__ import annotations

import os
import runpy
from pathlib import Path


for entry in os.environ.get("LOHRA_PARITY_ORIGINAL_PYTHONPATH", "").split(os.pathsep):
    candidate = Path(entry) / "sitecustomize.py"
    if candidate.is_file() and candidate.resolve() != Path(__file__).resolve():
        runpy.run_path(str(candidate))
        break

provider_url = os.environ.get("LOHRA_PROVIDER_BASE_URL")
if provider_url:
    from lohra.providers import builtin

    object.__setattr__(builtin.OLLAMA, "base_url", provider_url)
    builtin.register_builtin_providers()

ollama_connect_url = os.environ.get("LOHRA_OLLAMA_CONNECT_URL")
if ollama_connect_url:
    from dataclasses import replace
    from lohra.onboarding import detect

    original_probe = detect.probe_ollama

    def redirected_probe(*, client=None, timeout=detect.OLLAMA_TIMEOUT, url=detect.OLLAMA_TAGS_URL):
        result = original_probe(client=client, timeout=timeout, url=ollama_connect_url)
        return replace(result, url=url)

    detect.probe_ollama = redirected_probe
