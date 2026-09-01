"""The pinned oracle's MCP transport boundary, driven only by fixture JSON."""
from __future__ import annotations

import json
import os


class FixtureSession:
    def __init__(self, server: str, spec: dict, config) -> None:
        self.server = server
        self.spec = spec
        self.config = config
        self._list_calls = 0

    def list_tools(self) -> list:
        if self.spec.get("list_tools_raises"):
            raise RuntimeError(self.spec["list_tools_raises"])
        self._list_calls += 1
        if self._list_calls > 1 and "refresh_tools" in self.spec:
            return list(self.spec["refresh_tools"])
        return list(self.spec.get("tools", []))

    def call_tool(self, name: str, args: dict):
        if self.spec.get("call_raises"):
            raise RuntimeError(self.spec["call_raises"])
        results = self.spec.get("call_results", {})
        if name in results:
            return results[name]
        if self.spec.get("echo_config"):
            observed = {
                "name": self.config.name,
                "transport": self.config.transport,
                "command": self.config.command,
                "args": list(self.config.args),
                "env": dict(self.config.env),
                "url": self.config.url,
            }
            return {
                "content": [{
                    "type": "text",
                    "text": "observed-config:" + json.dumps(
                        observed, separators=(",", ":")
                    ),
                }],
                "isError": False,
            }
        return {
            "content": [{
                "type": "text",
                "text": f"served-by:{self.server}:{name}:{json.dumps(args, separators=(',', ':'))}",
            }],
            "isError": False,
        }

    def close(self) -> None:
        return None


def install() -> None:
    raw = os.environ.get("T19_MCP_FIXTURE")
    if not raw:
        return
    servers = json.loads(raw).get("servers", {})

    def factory(config):
        spec = servers.get(config.name)
        if spec is None:
            raise RuntimeError(f"no fixture for MCP server {config.name!r}")
        if spec.get("connect_raises"):
            raise RuntimeError(spec["connect_raises"])
        return FixtureSession(config.name, spec, config)

    import lohra.mcp.session as session_mod
    session_mod.connect_session = factory
