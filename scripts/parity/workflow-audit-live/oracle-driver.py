from __future__ import annotations

import json
import tempfile
from pathlib import Path

from lohra.state import SessionDB
from lohra.workflow.audit import (
    DEFAULT_MAX_EVENT_BYTES, DEFAULT_MAX_EVENTS_PER_RUN, DEFAULT_MAX_RUNS,
    DEFAULT_QUEUE_LIMIT, DEFAULT_RETENTION_SECONDS, sanitize_audit_event,
)
from lohra.workflow.events import DONE, ITEMS, NODE, PLAN, EventEmitter

CANARY = "T17_PRIVATE_CANARY_🔒_秘密_🧪"

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
        "limits": {"event_bytes": DEFAULT_MAX_EVENT_BYTES, "events_per_run": DEFAULT_MAX_EVENTS_PER_RUN,
                   "runs": DEFAULT_MAX_RUNS, "queue": DEFAULT_QUEUE_LIMIT, "retention_seconds": DEFAULT_RETENTION_SECONDS},
        "privacy": {"canary_absent": CANARY not in json.dumps(safe, ensure_ascii=False),
                    "states": [safe["data"][key]["state"] for key in ("prompt", "response", "reasoning", "content", "arguments", "result")]},
        "sqlite": {"snapshot": snap, "frozen": [row["seq"] for row in frozen["events"]], "tail": [row["seq"] for row in tail["events"]],
                   "retained": [row["seq"] for row in retained_events[1:]], "dropped": retained_events[0]["data"]["dropped_count"],
                   "resumed": resurrected[1]["seq"]},
        "live": {"outcomes": outcomes, "delivered": delivered, "tracked": emitter.tracked_nodes()},
    }, sort_keys=True))

if __name__ == "__main__": main()
