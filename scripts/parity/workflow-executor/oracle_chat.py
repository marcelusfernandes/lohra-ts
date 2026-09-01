#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from lohra.agent.agent import Agent
from lohra.agent.client import ModelClient, OpenAIClient
from lohra.agent.loop import run_conversation
from lohra.providers.base import ProviderProfile
from lohra.state import SessionDB
from lohra.workflow.service import WorkflowService
from lohra.workflow.tools import WorkflowTool


class ChildClient(ModelClient):
    def __init__(self, requests: list[dict[str, Any]]) -> None:
        self.requests = requests

    def create(self, **kwargs: Any) -> Any:
        messages = kwargs.get("messages") or []
        prompt = str(messages[-1].get("content") if messages else "")
        self.requests.append({"prompt": prompt, "role": "agent"})
        return {
            "content": [{"type": "text", "text": "leaf-output"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 5, "output_tokens": 3},
        }


home = Path(os.environ["HOME"])
db = SessionDB(":memory:")
leaf_requests: list[dict[str, Any]] = []
child_provider = ProviderProfile(name="child", api_mode="anthropic_messages")


def child_factory() -> Agent:
    return Agent(model="canned", provider=child_provider, client=ChildClient(leaf_requests))


service = WorkflowService(base_child_factory=child_factory, db=db, home=home)
tool = WorkflowTool(service)
tool_definition = {
    "type": "function",
    "function": {
        "name": "run_workflow",
        "description": "Run workflow",
        "parameters": {
            "type": "object",
            "properties": {"spec": {"type": "object"}},
            "required": ["spec"],
        },
    },
}
outer_provider = ProviderProfile(
    name="stub",
    api_mode="chat_completions",
    base_url="http://127.0.0.1:11434/v1",
    requires_api_key=False,
    default_max_tokens=8192,
)
client = OpenAIClient(api_key="lohra-local", base_url=outer_provider.base_url)
agent = Agent(
    model="stub-coder:1b",
    provider=outer_provider,
    client=client,
    system_message="T15 canned workflow chat",
    tool_definitions=(tool_definition,),
    tool_dispatch=lambda name, args: tool.run(args) if name == "run_workflow" else json.dumps({"error": f"unexpected {name}"}),
    max_iterations=4,
)

try:
    turn = run_conversation(agent, "run the canned workflow")
    tool_message = next(message for message in turn["messages"] if message.get("role") == "tool")
    assistant_tool = next(message for message in turn["messages"] if message.get("tool_calls"))
    call = assistant_tool["tool_calls"][0]
    arguments = call["function"]["arguments"]
    started = json.loads(tool_message["content"])
    status = service.status(started["run_id"], wait=True)
    request_path = Path(os.environ["LOHRA_PARITY_PROFILE"]) / "stub-requests.jsonl"
    request_bodies = [json.loads(line)["body"] for line in request_path.read_text(encoding="utf-8").splitlines() if line]
    requests = [
        {
            "model": body.get("model"),
            "maxTokens": body.get("max_tokens"),
            "roles": [message.get("role") for message in body.get("messages", [])],
            "hasRunWorkflow": any(entry.get("function", {}).get("name") == "run_workflow" for entry in body.get("tools", [])),
        }
        for body in request_bodies
    ]
    projection = {
        "final": turn["final_response"],
        "apiCalls": turn["api_calls"],
        "tool": {
            "name": call["function"]["name"],
            "args": json.loads(arguments),
            "started": {
                "ok": started["ok"],
                "run_id": "<RUN_ID>",
                "accepted": started["status"] in ("started", "running"),
            },
        },
        "run": {
            "run_id": "<RUN_ID>",
            "status": status["status"],
            "outputs": status["outputs"],
            "faults": status["faults"],
            "null_count": status["null_count"],
            "engine_faults": status["engine_faults"],
            "cap_trips": status["cap_trips"],
            "validation_retries": status["validation_retries"],
            "tokens": [
                status["tokens_in"],
                status["tokens_out"],
                status.get("cache_read_tokens", 0),
                status.get("cache_write_tokens", 0),
                status.get("reasoning_tokens", 0),
            ],
        },
        "leafRequests": leaf_requests,
        "requests": requests,
    }
    print(json.dumps(projection, ensure_ascii=False, separators=(",", ":")))
finally:
    client.close()
    service.shutdown()
    db.close()
