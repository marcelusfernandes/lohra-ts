from __future__ import annotations

import json
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from lohra.agent.agent import Agent
from lohra.agent.client import ModelClient
from lohra.providers import get_provider_profile
from lohra.state import SessionDB
from lohra.workflow.audit import (
    DEFAULT_MAX_EVENT_BYTES, DEFAULT_MAX_EVENTS_PER_RUN, DEFAULT_MAX_RUNS,
    DEFAULT_QUEUE_LIMIT, DEFAULT_RETENTION_SECONDS, sanitize_audit_event,
)
from lohra.workflow.audit_query import WorkflowAuditTool
from lohra.workflow.events import DONE, ITEMS, NODE, PLAN, EventEmitter
from lohra.workflow.service import WorkflowService

CANARY = "T17_PRIVATE_CANARY_🔒_秘密_🧪"


class CannedClient(ModelClient):
    def create(self, **_kwargs: Any) -> dict[str, Any]:
        return {
            "content": [{"type": "text", "text": "canned-complete"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 5, "output_tokens": 3},
        }

    def stream(self, **kwargs: Any) -> dict[str, Any]:
        return self.create(**kwargs)


def canned_projection(root: Path) -> dict[str, Any]:
    db = SessionDB(str(root / "canned.db"))
    client = CannedClient()

    def factory() -> Agent:
        return Agent(
            model="audit-test",
            provider=get_provider_profile("anthropic"),
            client=client,
        )

    service = WorkflowService(base_child_factory=factory, db=db, home=root, max_runs=1)
    try:
        started = service.start({
            "meta": {"name": "t17-canned"},
            "nodes": [{"id": "leaf", "type": "agent", "prompt": CANARY}],
        })
        run_id = started["run_id"]
        result = service.status(run_id, wait=True, timeout=10)
        assert service._audit.flush(timeout=2)
        page = json.loads(WorkflowAuditTool(db).handle({"run_id": run_id, "limit": 100}))
        assert page["ok"] is True
        event_types = [row["event_type"] for row in page["events"]]
        encoded = json.dumps(page, ensure_ascii=False)
        return {
            "status": result["status"],
            "lifecycle": {
                "plan": "segment.started" in event_types,
                "node_started": "node.started" in event_types,
                "node_completed": "node.completed" in event_types,
                "done": "segment.completed" in event_types,
            },
            "canary_absent": CANARY not in encoded,
            "tool_ok": page["ok"],
        }
    finally:
        service.shutdown()
        db.close()

def event(run_id: str, turn: int, event_type: str = "node.started"):
    return {"schema_version": 1, "event_type": event_type, "provenance": "observed",
            "identity": {"run_id": run_id, "segment_id": "s", "node_path": ["n"], "turn": turn},
            "data": {"state": "running"}}

def append(db, value, now, max_events=10, max_runs=64):
    return db.audit_append(value, now=now, max_events=max_events, max_runs=max_runs, retention_seconds=1_000_000)

def main():
    raw = event("privacy", 1, "leaf.completed")
    raw["data"] = {key: CANARY for key in ("prompt", "response", "reasoning", "content", "arguments", "result")}
    safe = sanitize_audit_event(raw)
    with tempfile.TemporaryDirectory(prefix="lohra-t17-oracle-") as directory:
        root = Path(directory)
        privacy_path = root / "privacy.db"
        privacy = SessionDB(str(privacy_path))
        append(privacy, raw, 4000)
        privacy_page = privacy.audit_query("privacy", limit=10)
        unknown_read_model = privacy.audit_query("unknown-run")
        privacy.close()
        with sqlite3.connect(privacy_path) as stored:
            stored_privacy = [
                str(row[0])
                for row in stored.execute(
                    "SELECT payload_json FROM workflow_audit_events WHERE run_id='privacy'"
                ).fetchall()
            ]
        snapshot = SessionDB(str(root / "snapshot.db"))
        for turn in range(3): append(snapshot, event("snapshot", turn), 1000 + turn)
        first = snapshot.audit_query("snapshot", limit=1)
        snap = first["page"]["snapshot_seq"]
        append(snapshot, event("snapshot", 3), 1003)
        frozen = snapshot.audit_query("snapshot", after_seq=1, snapshot_seq=snap, limit=10)
        tail = snapshot.audit_query("snapshot", after_seq=snap, limit=10)
        snapshot.close()

        retained = SessionDB(str(root / "retained.db"))
        for turn in range(5): append(retained, event("retained", turn), 2000 + turn, max_events=3)
        retained_events = retained.audit_events("retained")
        retained.close()

        tomb = SessionDB(str(root / "tomb.db"))
        append(tomb, event("r1", 0), 3000, max_runs=1)
        append(tomb, event("r2", 0), 3001, max_runs=1)
        append(tomb, event("r1", 1), 3002, max_runs=1)
        resurrected = tomb.audit_events("r1")
        tomb.close()
        canned = canned_projection(root)

    ticks = iter([0.0, 0.1, 0.1, 1.0, 1.1])
    delivered = []
    emitter = EventEmitter(lambda run, kind, payload: delivered.append(kind), clock=lambda: next(ticks), items_interval=1.0)
    outcomes = [
        emitter.emit("live", PLAN, {"nodes": []}),
        emitter.emit("live", ITEMS, {"node_id": "a", "done": 0, "total": 3}),
        emitter.emit("live", ITEMS, {"node_id": "a", "done": 1, "total": 3}),
        emitter.emit("live", ITEMS, {"node_id": "b", "done": 1, "total": 3}),
        emitter.emit("live", ITEMS, {"node_id": "a", "done": 2, "total": 3}),
        emitter.emit("live", ITEMS, {"node_id": "a", "done": 3, "total": 3}),
        emitter.emit("live", NODE, {"node_id": "a", "state": "complete"}),
        emitter.emit("live", DONE, {"status": "complete"}),
    ]
    print(json.dumps({
        "projection": {
            "limits": {"event_bytes": DEFAULT_MAX_EVENT_BYTES, "events_per_run": DEFAULT_MAX_EVENTS_PER_RUN,
                       "runs": DEFAULT_MAX_RUNS, "queue": DEFAULT_QUEUE_LIMIT, "retention_seconds": DEFAULT_RETENTION_SECONDS},
            "privacy": {"canary_absent": CANARY not in json.dumps(safe, ensure_ascii=False),
                        "states": [safe["data"][key]["state"] for key in ("prompt", "response", "reasoning", "content", "arguments", "result")],
                        "public_canary_absent": CANARY not in json.dumps(privacy_page, ensure_ascii=False),
                        "database_canary_absent": CANARY not in json.dumps(stored_privacy, ensure_ascii=False)},
            "unknown_read_model": unknown_read_model,
            "sqlite": {"snapshot": snap, "frozen": [row["seq"] for row in frozen["events"]], "tail": [row["seq"] for row in tail["events"]],
                       "retained": [row["seq"] for row in retained_events[1:]], "dropped": retained_events[0]["data"]["dropped_count"],
                       "resumed": resurrected[1]["seq"]},
            "live": {"outcomes": outcomes, "delivered": delivered, "tracked": emitter.tracked_nodes()},
        },
        "canned": canned,
    }, sort_keys=True))

if __name__ == "__main__": main()
