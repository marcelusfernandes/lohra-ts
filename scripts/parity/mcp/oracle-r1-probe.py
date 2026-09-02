from __future__ import annotations

import json

from lohra.agent.delegate import _CHILD_EXCLUDED_TOOLS, child_tool_definitions
from lohra.agent.equip import register_all_tools
from lohra.mcp.tools import register_server_tools
from lohra.tools.registry import registry

tools = [
    {"name": "echo", "description": "Echo text back.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "search_docs", "description": "Search the docs.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "Weird-Name!", "description": "Sanitization probe.", "inputSchema": {"type": "object", "properties": {}}},
]
register_all_tools()
register_server_tools(
    registry,
    "fix",
    tools,
    call_tool=lambda _name, _args: {"content": [], "isError": False},
)
parent = [entry["function"]["name"] for entry in registry.get_definitions()]
child = [entry["function"]["name"] for entry in child_tool_definitions(tuple(registry.get_definitions()))]
removed = sorted(name for name in parent if name not in child)
excluded_intersection = sorted(name for name in _CHILD_EXCLUDED_TOOLS if name in parent)
historical_allowlist = ["read_file", "write_file", "terminal", "web_fetch", "web_search"]
print(json.dumps({
    "parent": parent,
    "child": child,
    "removed": removed,
    "excludedIntersection": excluded_intersection,
    "removedEqualsExcludedIntersection": removed == excluded_intersection,
    "AIntersectEIsEmpty": all(name not in _CHILD_EXCLUDED_TOOLS for name in historical_allowlist),
    "AIntersectPSubsetOfPMinusE": all(
        name in child for name in historical_allowlist if name in parent
    ),
}, separators=(",", ":")))
