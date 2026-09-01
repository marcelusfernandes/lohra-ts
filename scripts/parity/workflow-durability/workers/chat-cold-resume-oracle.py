#!/usr/bin/env python3
"""Canned chat that CROSSES A PROCESS BOUNDARY (contract 47).

Turn 1 runs `run_workflow` over the canned transport until the spec parks at a
checkpoint and the durable line is written. Turn 2 runs in a BRAND NEW process
(`--resume`), which reopens the same on-disk DB, answers the checkpoint through
`run_workflow(resume_run_id=..., checkpoint_answers=...)`, and finishes the run
by replaying the cell turn 1 already paid for. Read-only w.r.t. the oracle repo;
every write lands under $HOME, which the manifest points at a temp profile.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from lohra.agent.agent import Agent
from lohra.agent.client import ModelClient, OpenAIClient
from lohra.agent.loop import run_conversation
from lohra.providers.base import ProviderProfile
from lohra.state import SessionDB
from lohra.workflow.service import WorkflowService
from lohra.workflow.tools import WorkflowTool

HOME = Path(os.environ["HOME"])
DB_PATH = HOME / "durable.db"
SPEC = {
    "meta": {"name": "cold"},
    "nodes": [
        {"id": "a", "type": "agent", "prompt": "first"},
        {"id": "gate", "type": "checkpoint", "prompt": "approve?"},
    ],
}


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


def make_service(db: SessionDB, requests: list[dict[str, Any]]) -> WorkflowService:
    child_provider = ProviderProfile(name="child", api_mode="anthropic_messages")

    def child_factory() -> Agent:
        return Agent(model="canned", provider=child_provider, client=ChildClient(requests))

    return WorkflowService(base_child_factory=child_factory, db=db, home=HOME)


def line_of(db: SessionDB, run_id: str) -> dict[str, Any]:
    row = db.run_state_get(run_id) or {}
    return {
        "status": row.get("status"),
        "pause_reason": row.get("pause_reason"),
        "has_spec": bool(row.get("spec_json")),
    }


def cells_of(db: SessionDB, run_id: str) -> int:
    row = db._connection.execute(
        "SELECT count(*) AS n FROM workflow_node_cache WHERE run_id = ?", (run_id,)
    ).fetchone()
    return int(row["n"])


def resume_phase(run_id: str) -> None:
    """Turn 2 — a process that never saw turn 1's engine, only its rows."""
    db = SessionDB(str(DB_PATH))
    requests: list[dict[str, Any]] = []
    service = make_service(db, requests)
    tool = WorkflowTool(service)
    try:
        envelope = json.loads(
            tool.run({"resume_run_id": run_id, "checkpoint_answers": {"gate": "yes"}})
        )
        status = service.status(run_id, wait=True)
        print(
            json.dumps(
                {
                    "resumeAccepted": envelope.get("status") in ("started", "running"),
                    "status": status["status"],
                    "outputs": status["outputs"],
                    "line": line_of(db, run_id),
                    "cells": cells_of(db, run_id),
                    "leafRequests": len(requests),
                },
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
        )
    finally:
        service.shutdown()
        db.close()


if "--resume" in sys.argv:
    resume_phase(sys.argv[sys.argv.index("--resume") + 1])
    raise SystemExit(0)

db = SessionDB(str(DB_PATH))
leaf_requests: list[dict[str, Any]] = []
service = make_service(db, leaf_requests)
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
    system_message="T16 canned durable workflow chat",
    tool_definitions=(tool_definition,),
    tool_dispatch=lambda name, args: tool.run(args)
    if name == "run_workflow"
    else json.dumps({"error": f"unexpected {name}"}),
    max_iterations=4,
)

try:
    turn = run_conversation(agent, "run the canned workflow")
    tool_message = next(m for m in turn["messages"] if m.get("role") == "tool")
    started = json.loads(tool_message["content"])
    paused = service.status(started["run_id"], wait=True)
    run_id = started["run_id"]
    first = {
        "runId": "<RUN_ID>",
        "status": paused["status"],
        "reason": paused.get("reason"),
        "checkpointNode": (paused.get("checkpoint") or {}).get("node_id"),
        "line": line_of(db, run_id),
        "cells": cells_of(db, run_id),
        "leafRequests": len(leaf_requests),
    }
finally:
    client.close()
    service.shutdown()
    db.close()

# Turn 2 in a NEW process: the run only survives through its durable rows.
child = subprocess.run(
    [sys.executable, os.path.abspath(__file__), "--resume", run_id],
    capture_output=True,
    text=True,
    check=False,
    env=os.environ,
)
if child.returncode != 0:
    sys.stderr.write(child.stderr)
    raise SystemExit(f"resume process failed: {child.returncode}")
second = json.loads(child.stdout.strip().splitlines()[-1])

print(
    json.dumps(
        {"turn1": first, "turn2": second, "resumedInNewProcess": True},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
)
