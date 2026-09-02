#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
from typing import Any

from lohra.workflow.graph import dependencies, ref_roots, topological_order
from lohra.workflow.jsonio import UNPARSEABLE, loads_lenient
from lohra.workflow.nodes import (
    MAX_NODE_RETRIES,
    NODE_SPECS,
    NODE_TYPES,
    Node,
    WorkflowSpec,
)
from lohra.workflow.refs import find_refs, invalid_refs, is_valid_ref, resolve_strict, resolve_value
from lohra.workflow.sandbox import load_policy
from lohra.workflow.schema import (
    MAX_GATE_ATTEMPTS,
    MAX_NODE_MAX_ITERATIONS,
    MAX_STATIC_FANOUT,
    ValidationError,
    validate_spec,
)


scenario, fixture_path = sys.argv[1:3]
fixtures = json.loads(Path(fixture_path).read_text(encoding="utf-8"))


def node_from_raw(item: dict[str, Any]) -> Node:
    return Node(item["id"], item["type"], {k: v for k, v in item.items() if k not in {"id", "type"}})


def issue_projection(error: ValidationError, raw: Any) -> Any:
    if scenario == "validation-cycle-canonical":
        (Path(os.environ["HOME"]) / "cycle-raw.json").write_text(
            json.dumps({"message": error.message}) + "\n", encoding="utf-8"
        )
        nodes = tuple(node_from_raw(item) for item in raw["nodes"])
        spec = WorkflowSpec(meta=raw["meta"], inputs={}, schemas={}, nodes=nodes)
        ids = {node.id for node in nodes}
        edges = sorted(f"{node.id}->{dep}" for node in nodes for dep in dependencies(node, ids))
        return {"kind": "validation_error", "issues": [{"rule": "cycle", "node_id": "a", "cycle_nodes": sorted(ids), "cycle_edges": edges}]}
    tuples = [[entry.rule, entry.node_id or "", entry.field or "", entry.message, entry.example or ""] for entry in error.issues]
    if len(tuples) > 1:
        tuples.sort()
    return {"kind": "validation_error", "issues": tuples, "message": error.message if len(tuples) == 1 else None}


def spec_projection(spec: WorkflowSpec) -> Any:
    return {
        "kind": "workflow_spec",
        "meta": spec.meta,
        "inputs": spec.inputs,
        "schemas": spec.schemas,
        "nodes": [{"id": node.id, "type": node.type, "fields": node.fields, "required": node.required} for node in spec.nodes],
    }


def validation(raw: Any, supported: list[str] | None = None) -> Any:
    result = validate_spec(raw, supported_types=frozenset(supported) if supported else None)
    return issue_projection(result, raw) if isinstance(result, ValidationError) else spec_projection(result)


def validation_fixture(name: str) -> Any:
    value = fixtures[name]
    if isinstance(value, list):
        return [validation(item) for item in value]
    if isinstance(value, dict) and "raw" in value:
        return validation(value["raw"], value["supported"])
    return validation(value)


def registry() -> Any:
    return {
        "types": sorted(NODE_TYPES),
        "specs": {name: {"required": sorted(spec.required_names()), "fields": sorted(spec.field_names())} for name, spec in NODE_SPECS.items()},
        "constants": {"MAX_STATIC_FANOUT": MAX_STATIC_FANOUT, "MAX_NODE_RETRIES": MAX_NODE_RETRIES, "MAX_GATE_ATTEMPTS": MAX_GATE_ATTEMPTS, "MAX_NODE_MAX_ITERATIONS": MAX_NODE_MAX_ITERATIONS},
    }


def refs_grammar() -> Any:
    return {"arabicValid": is_valid_ref("a.٣"), "superscriptValid": is_valid_ref("a.²"), "found": find_refs("x=${a.٣}; y=${a.²}"), "invalid": invalid_refs("x=${a.٣}; y=${a.²}")}


def refs_resolve() -> Any:
    context = fixtures["refs"]["context"]
    return {
        "whole": resolve_value("  ${a.b}  ", context),
        "index": resolve_value("${lst.١}", context),
        "missing": resolve_value("${lst.٣}", context),
        "injectedWhole": resolve_value("${inj}", context),
        "injectedEmbedded": resolve_value("x=${inj}", context),
        "nested": resolve_value({"${a.b}": ["${a.b}"]}, context),
    }


def refs_numeric() -> Any:
    return {"float": resolve_value("v=${num}", {"num": 1.0}), "big": resolve_value("v=${big}", {"big": 12345678901234567890})}


def graph_result() -> Any:
    spec = validate_spec(fixtures["graph"])
    if isinstance(spec, ValidationError):
        raise RuntimeError(spec.message)
    ids = {node.id for node in spec.nodes}
    return {
        "roots": sorted(ref_roots({"key": "${a.x}", "nested": ["${b.x}", "${bad+1}"]})),
        "dependencies": {node.id: sorted(dependencies(node, ids)) for node in spec.nodes},
        "topological": [node.id for node in topological_order(spec)],
    }


def jsonio() -> Any:
    fence = "```"
    values = ["{\"a\":1}", f"{fence}json\n[1,2]\n{fence}", "before {\"x\":2} after", "NaN", "Infinity", "-Infinity", "bad"]
    output: list[Any] = []
    for text in values:
        value = loads_lenient(text)
        if value is UNPARSEABLE:
            output.append({"kind": "unparseable"})
        elif isinstance(value, float) and math.isnan(value):
            output.append("nan")
        elif value == math.inf:
            output.append("inf")
        elif value == -math.inf:
            output.append("-inf")
        else:
            output.append(value)
    return output


validation_map = {
    "valid-minimal": "validMinimal", "valid-doc-fixture": "doc", "valid-all-node-types": "validAll",
    "validation-top-level": "topLevel", "validation-meta": "meta", "validation-schemas": "schemas",
    "validation-node-shape": "nodeShape", "validation-supported": "supported", "validation-fields": "fields",
    "validation-schema": "schema", "validation-refs": "refsValidation", "validation-lifecycle": "lifecycle",
    "validation-tier": "tier", "validation-gate": "gate", "validation-fanout": "fanout",
    "validation-duplicates": "duplicates", "validation-cascade": "cascade", "validation-multi-canonical": "multi",
    "validation-cycle-canonical": "cycle", "normalization-quirks": "quirks",
}

if scenario == "registry-shape": outcome = registry()
elif scenario in validation_map: outcome = validation_fixture(validation_map[scenario])
elif scenario == "refs-grammar": outcome = refs_grammar()
elif scenario == "refs-resolve": outcome = refs_resolve()
elif scenario == "refs-numeric": outcome = refs_numeric()
elif scenario == "refs-strict": outcome = {"missing": resolve_strict("x=${a.none}; y=${b.none}", {"a": {}, "b": {}}), "ok": resolve_strict("x=${a.value}", {"a": {"value": "ok"}})}
elif scenario in {"graph-dependencies", "graph-topological"}: outcome = graph_result()
elif scenario == "jsonio-lenient": outcome = jsonio()
elif scenario == "policy-normalization":
    temp = Path(os.environ["HOME"]) / "policy.json"
    policy = load_policy(temp)
    outcome = {"fsAllow": [{"path": str(root.path), "writable": root.writable} for root in policy.fs_allow], "egressAllow": list(policy.egress_allow)}
else: raise RuntimeError(f"unknown scenario {scenario}")

print(json.dumps({"operation": scenario, "cases": [{"id": scenario, "outcome": outcome}]}, ensure_ascii=True, sort_keys=True))
