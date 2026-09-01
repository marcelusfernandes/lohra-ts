#!/usr/bin/env python3
from __future__ import annotations

import json
from typing import Any

from lohra.agent.agent import Agent
from lohra.agent.client import ModelClient
from lohra.orchestration.core import OrchestrationCore
from lohra.providers import get_provider_profile
from lohra.state import SessionDB
from lohra.workflow.budget import Budget
from lohra.workflow.cache import NodeCache
from lohra.workflow.engine import WorkflowEngine
from lohra.workflow.schema import validate_spec


class RulesClient(ModelClient):
    def __init__(self, owner: "Factory") -> None:
        self.owner = owner
        self.calls = 0

    def create(self, **kwargs: Any) -> Any:
        self.calls += 1
        self.owner.calls += 1
        messages = kwargs.get("messages") or []
        prompt = str(messages[-1].get("content") if messages else "")
        kind = classify(prompt)
        targeted = self.owner.fail in {kind, "all"}
        if self.owner.fail == "parallel.branch" and prompt in {"a", "b"}:
            targeted = True
        if targeted:
            raise RuntimeError(f"dead:{kind}")
        if self.owner.fail == "schema" and self.calls == 1:
            text = '{"wrong":true}'
        elif kind == "verify.skeptic":
            text = '{"refuted":false,"reason":"ok"}'
        elif kind == "judge.review":
            text = '{"score":9,"rationale":"ok"}'
        elif kind == "judge.attempt":
            text = "draft"
        elif kind == "judge.synthesis":
            text = "final"
        elif kind == "loop.round":
            text = "item" if "harvest 0" in prompt else ""
        elif kind == "gate.body":
            text = "draft"
        elif kind == "gate.reviewer":
            text = '{"ok":true,"feedback":""}'
        elif kind == "completeness":
            text = '{"complete":true,"missing":[]}'
        elif self.owner.fail == "schema":
            text = '{"value":1}'
        else:
            text = "ok"
        return {
            "content": [{"type": "text", "text": text}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 5, "output_tokens": 3},
        }


def classify(prompt: str) -> str:
    if "skeptic reviewing" in prompt:
        return "verify.skeptic"
    if "Score this attempt" in prompt:
        return "judge.review"
    if "WINNER:" in prompt or "polish" in prompt:
        return "judge.synthesis"
    if "harvest" in prompt:
        return "loop.round"
    if "approve" in prompt and prompt != "approve":
        return "gate.reviewer"
    if "auditing whether a task" in prompt.lower() or "Task:" in prompt:
        return "completeness"
    if prompt in {"attempt", "draft"}:
        return "judge.attempt" if prompt == "attempt" else "gate.body"
    if prompt.startswith("pipe "):
        return "pipeline.stage"
    return "agent"


class Factory:
    def __init__(self, fail: str = "") -> None:
        self.fail = fail
        self.calls = 0
        self.spawns = 0

    def __call__(self) -> Agent:
        self.spawns += 1
        provider = get_provider_profile("anthropic")
        assert provider is not None
        return Agent(model="canned", provider=provider, client=RulesClient(self))


child = {"meta": {"name": "child", "version": 1}, "nodes": [{"id": "inner", "type": "agent", "prompt": "nested"}]}

success_specs: dict[str, dict[str, Any]] = {
    "agent": {"meta": {"name": "agent"}, "nodes": [{"id": "n", "type": "agent", "prompt": "answer"}]},
    "parallel": {"meta": {"name": "parallel"}, "nodes": [{"id": "n", "type": "parallel", "branches": ["a", "b"]}]},
    "pipeline": {"meta": {"name": "pipeline"}, "nodes": [{"id": "n", "type": "pipeline", "items": ["a", "b"], "stages": [{"prompt": "pipe ${item}"}]}]},
    "verify": {"meta": {"name": "verify"}, "nodes": [{"id": "n", "type": "verify", "finding": "claim", "skeptics": 1, "kill_if_majority_refute": True}]},
    "judge_panel": {"meta": {"name": "judge"}, "nodes": [{"id": "n", "type": "judge_panel", "attempts": ["attempt"], "judges": 1, "synthesize": {"prompt": "polish ${winner}"}}]},
    "loop_until_dry": {"meta": {"name": "loop"}, "nodes": [{"id": "n", "type": "loop_until_dry", "body": {"prompt": "harvest ${round}"}, "stop_after_k_empty": 1, "max_rounds": 3}]},
    "workflow": {"meta": {"name": "workflow"}, "nodes": [{"id": "n", "type": "workflow", "ref": "child"}]},
    "gate": {"meta": {"name": "gate"}, "nodes": [{"id": "n", "type": "gate", "body": {"prompt": "draft"}, "validator": "approve", "attempts": 1}]},
    "completeness_check": {"meta": {"name": "completeness"}, "nodes": [{"id": "n", "type": "completeness_check", "task": "task", "results": ["result"]}]},
    "checkpoint": {"meta": {"name": "checkpoint"}, "nodes": [{"id": "n", "type": "checkpoint", "prompt": "approve?"}]},
}


def projection(result: Any, factory: Factory) -> dict[str, Any]:
    return {
        "status": result.status,
        "outputs": result.outputs,
        "faults": len(result.faults),
        "nullCount": result.null_count,
        "engineFaults": result.engine_faults,
        "capTrips": result.cap_trips,
        "validationRetries": result.validation_retries,
        "nodesTotal": result.nodes_total,
        "tokens": [result.tokens_in, result.tokens_out, result.cache_read_tokens, result.cache_write_tokens, result.reasoning_tokens],
        "spawns": factory.spawns,
    }


def run_one(raw: dict[str, Any], *, fail: str = "", budget: Budget | None = None, args: dict[str, Any] | None = None, answers: dict[str, Any] | None = None) -> tuple[dict[str, Any], Factory]:
    db = SessionDB(":memory:")
    factory = Factory(fail)
    core = OrchestrationCore(db, factory, max_concurrent=4)
    try:
        engine = WorkflowEngine(
            core,
            budget=budget or Budget(),
            loader=lambda ref: child if ref == "child" else None,
            checkpoint_answers=answers or {},
        )
        result = engine.run(validate_spec(raw), args or {})
        return projection(result, factory), factory
    finally:
        core.shutdown()
        db.close()


successes = {}
for name, raw in success_specs.items():
    successes[name], _ = run_one(raw, answers={"n": False} if name == "checkpoint" else None)

failure_roles = {
    "agent": "agent", "parallel": "parallel.branch", "pipeline": "pipeline.stage",
    "verify": "verify.skeptic", "judge_panel": "judge.attempt", "loop_until_dry": "loop.round",
    "gate": "gate.body", "completeness_check": "completeness",
}
failures = {name: run_one(success_specs[name], fail=role)[0] for name, role in failure_roles.items()}
failures["checkpoint"] = run_one(success_specs["checkpoint"])[0]

deep = {"meta": {"name": "deep"}, "nodes": [{"id": "deep", "type": "workflow", "ref": "child"}]}
db = SessionDB(":memory:")
factory = Factory()
core = OrchestrationCore(db, factory)
try:
    depth = WorkflowEngine(core, budget=Budget(), loader=lambda _ref: deep).run(validate_spec(success_specs["workflow"]), {})
    failures["workflow"] = projection(depth, factory)
finally:
    core.shutdown(); db.close()

fanout = run_one(
    {"meta": {"name": "fanout"}, "nodes": [{"id": "n", "type": "parallel", "branches": "${args.items}"}]},
    args={"items": ["a", "b"]}, budget=Budget(max_fanout=1),
)[0]
budget_out = run_one(
    {"meta": {"name": "budget"}, "nodes": [{"id": "a", "type": "agent", "prompt": "a"}, {"id": "b", "type": "agent", "prompt": "b"}]},
    budget=Budget(token_budget=7),
)[0]
schema_retry = run_one(
    {"meta": {"name": "schema"}, "nodes": [{"id": "n", "type": "agent", "prompt": "x", "schema": {"type": "object", "required": ["value"]}}]},
    fail="schema",
)[0]
null_upstream = run_one(
    {"meta": {"name": "null-upstream"}, "nodes": [{"id": "a", "type": "agent", "prompt": "x", "retries": 0}, {"id": "b", "type": "agent", "prompt": "${a}"}]},
    fail="agent",
)[0]

# Deliberate engine strategy fault, restored before leaving this process.
from lohra.workflow import strategies as strategies_module
original = strategies_module.STRATEGIES["agent"]
def exploding(engine: Any, node: Any, context: Any) -> Any:
    if node.id == "bad":
        raise TypeError("boom")
    return "ok"
strategies_module.STRATEGIES["agent"] = exploding
try:
    engine_fault = run_one({"meta": {"name": "engine-fault"}, "nodes": [{"id": "bad", "type": "agent", "prompt": "x"}, {"id": "good", "type": "agent", "prompt": "y"}]})[0]
finally:
    strategies_module.STRATEGIES["agent"] = original

db = SessionDB(":memory:")
factory = Factory()
core = OrchestrationCore(db, factory)
cache = NodeCache(db, "same")
try:
    base = validate_spec({"meta": {"name": "cache"}, "nodes": [{"id": "n", "type": "agent", "prompt": "x"}]})
    changed = validate_spec({"meta": {"name": "cache"}, "nodes": [{"id": "n", "type": "agent", "prompt": "y"}]})
    WorkflowEngine(core, budget=Budget(), cache=cache).run(base, {})
    WorkflowEngine(core, budget=Budget(), cache=cache).run(base, {})
    WorkflowEngine(core, budget=Budget(), cache=cache).run(changed, {})
    historical = cache.total_split()
    cache_projection = {
        "spawns": factory.spawns,
        "split": {
            "inputTokens": historical.input_tokens,
            "outputTokens": historical.output_tokens,
            "cacheReadTokens": historical.cache_read_tokens,
            "cacheWriteTokens": historical.cache_write_tokens,
            "reasoningTokens": historical.reasoning_tokens,
        },
    }
finally:
    core.shutdown(); db.close()

print(json.dumps({"successes": successes, "failures": failures, "fanout": fanout, "budget": budget_out, "nullUpstream": null_upstream, "engineFault": engine_fault, "schemaRetry": schema_retry, "cache": cache_projection}, sort_keys=True))
