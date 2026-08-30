from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
from pathlib import Path

from lohra.memory.paths import state_db_path
from lohra.state.db import SessionDB


def emit(value: object) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True, sort_keys=True) + "\n")


def open_db(path: Path) -> SessionDB:
    path.parent.mkdir(parents=True, exist_ok=True)
    return SessionDB(str(path))


def core(root: Path) -> None:
    db = open_db(root / "state.db")
    try:
        db.create_session("fk-child", parent_session_id="missing-parent")
        db._connection.execute("DELETE FROM sessions WHERE id='fk-child'")
        db._connection.commit()
        db.create_session("core", model="stub-model", title="core")
        db._connection.execute("UPDATE sessions SET started_at = 1000.0 WHERE id = 'core'")
        db._connection.commit()
        db.save_message("core", {"role": "user", "content": "hello stub world"})
        tool_calls = [
            {
                "id": "c1",
                "type": "function",
                "function": {"name": "f", "arguments": '{"a": 1}'},
            }
        ]
        db.save_message(
            "core",
            {
                "role": "assistant",
                "content": None,
                "finish_reason": "tool_calls",
                "tool_calls": tool_calls,
                "provider_data": {"z": 2, "a": 1},
            },
        )
        db.save_message(
            "core",
            {"role": "tool", "name": "f", "tool_call_id": "c1", "content": "ok"},
        )
        db._connection.execute(
            "UPDATE messages SET timestamp = 1000.0 + id WHERE session_id = 'core'"
        )
        db._connection.commit()

        class Usage:
            input_tokens = 11
            output_tokens = 7
            cache_read_tokens = 0
            cache_write_tokens = 0
            reasoning_tokens = 0

        class SecondUsage:
            input_tokens = 1
            output_tokens = 1
            cache_read_tokens = 0
            cache_write_tokens = 0
            reasoning_tokens = 0

        db.session_add_usage("core", Usage(), real_usd=0.0, gross_usd=0.5, api_calls=2)
        db.session_add_usage("core", SecondUsage(), api_calls=1)
        usage = db.session_usage("core")
        row = db._connection.execute(
            "SELECT tool_calls, reasoning_details, typeof(actual_cost_usd), "
            "typeof(api_call_count), started_at FROM sessions JOIN messages "
            "ON messages.session_id=sessions.id WHERE messages.id=2"
        ).fetchone()
        emit(
            {
                "foreignKeyOff": True,
                "messages": db.load_messages("core"),
                "schemaVersion": db._connection.execute(
                    "SELECT value FROM state_meta WHERE key='schema_version'"
                ).fetchone()[0],
                "storage": {
                    "actualCost": row[2],
                    "apiCalls": row[3],
                    "startedAt": row[4],
                    "storedProviderData": row[1],
                    "storedToolCalls": row[0],
                },
                "usage": {
                    "actual_cost_usd": usage["actual_cost_usd"],
                    "api_calls": usage["api_call_count"],
                    "estimated_cost_usd": usage["estimated_cost_usd"],
                    "input_tokens": usage["input_tokens"],
                    "output_tokens": usage["output_tokens"],
                    "priced_call_count": usage["priced_call_count"],
                },
            }
        )
    finally:
        db.close()


def profile_isolation(root: Path) -> None:
    prior_home = os.environ.get("LOHRA_HOME")
    prior_profile = os.environ.get("LOHRA_PROFILE")
    os.environ["LOHRA_HOME"] = str(root)
    paths: dict[str, str] = {}
    try:
        for profile, sentinel in [(None, "default"), ("p1", "one"), ("p2", "two")]:
            if profile is None:
                os.environ.pop("LOHRA_PROFILE", None)
            else:
                os.environ["LOHRA_PROFILE"] = profile
            path = state_db_path()
            db = SessionDB(str(path))
            try:
                db.create_session(sentinel)
                db._connection.execute(
                    "UPDATE sessions SET started_at = ? WHERE id = ?",
                    ({"default": 1.0, "one": 2.0, "two": 3.0}[sentinel], sentinel),
                )
                db._connection.commit()
            finally:
                db.close()
            paths[profile or "default"] = str(path)
        visible: dict[str, list[str]] = {}
        for profile in [None, "p1", "p2"]:
            if profile is None:
                os.environ.pop("LOHRA_PROFILE", None)
            else:
                os.environ["LOHRA_PROFILE"] = profile
            db = SessionDB(str(state_db_path()))
            try:
                visible[profile or "default"] = [row["id"] for row in db.list_sessions()]
            finally:
                db.close()
        emit({"paths": paths, "visible": visible})
    finally:
        if prior_home is None:
            os.environ.pop("LOHRA_HOME", None)
        else:
            os.environ["LOHRA_HOME"] = prior_home
        if prior_profile is None:
            os.environ.pop("LOHRA_PROFILE", None)
        else:
            os.environ["LOHRA_PROFILE"] = prior_profile


def fts_lineage(root: Path) -> None:
    path = root / "state.db"
    db = open_db(path)
    try:
        parent = None
        for index in range(105):
            session_id = f"lin-{index:04d}"
            db.create_session(session_id, parent_session_id=parent)
            db._connection.execute(
                "UPDATE sessions SET started_at=? WHERE id=?", (float(index), session_id)
            )
            db._connection.commit()
            parent = session_id
        db.create_session("s1")
        db.create_session("s-arch")
        db.create_session("s-orch", source="orchestration")
        db._connection.execute("UPDATE sessions SET archived=1 WHERE id='s-arch'")
        db._connection.execute(
            "UPDATE sessions SET started_at = CASE id WHEN 's1' THEN 1000 WHEN 's-arch' "
            "THEN 999 ELSE 998 END WHERE id IN ('s1','s-arch','s-orch')"
        )
        db._connection.commit()
        db.save_message("lin-0104", {"role": "user", "content": "hello stub world"})
        db._connection.execute(
            "UPDATE messages SET timestamp=200.0 WHERE session_id='lin-0104'"
        )
        db._connection.commit()
        result = {
            "blank": db.search("   "),
            "default": [row["id"] for row in db.list_sessions(limit=200)],
            "includeArchived": [
                row["id"] for row in db.list_sessions(limit=200, include_archived=True)
            ],
            "lineage": db.lineage_root_to_tip("lin-0104"),
            "malformed": db.search("AND OR (( NEAR"),
            "search": db.search("hello stub"),
        }
    finally:
        db.close()
    reopened = open_db(path)
    try:
        result["searchAfterReopen"] = reopened.search("hello stub")
    finally:
        reopened.close()
    emit(result)


class WarningCapture(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[dict[str, object]] = []

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if "refused a stale" in message:
            self.records.append(
                {"cause": "STALE_FENCE_WRITE", "runId": "run-stale", "fence": 1}
            )


def locks_sequential(root: Path, mutant: bool = False) -> None:
    db = open_db(root / "state.db")
    capture = WarningCapture()
    logger = logging.getLogger("lohra.state.db")
    logger.addHandler(capture)
    try:
        compression = {
            "p1_acquire": db.acquire_compression_lock("s", "p1", ttl_seconds=300),
            "p2_contended": db.acquire_compression_lock("s", "p2", ttl_seconds=300),
            "release_wrong_holder": db.release_compression_lock("s", "wrong"),
        }
        db._connection.execute("UPDATE compression_locks SET expires_at=0 WHERE session_id='s'")
        db._connection.commit()
        compression["p2_after_ttl"] = db.acquire_compression_lock("s", "p2", ttl_seconds=300)
        compression["release_right_holder"] = db.release_compression_lock("s", "p2")

        first = db.acquire_run_lease("run-stale", "p1", ttl_seconds=1, now=10)
        db.run_state_put(
            "run-stale", {"owner": "p1", "status": "running"}, 10, fence=first
        )
        db.release_run_lease("run-stale", "p1")
        second = db.acquire_run_lease("run-stale", "p2", ttl_seconds=1, now=11)
        db.run_state_put(
            "run-stale", {"owner": "p2", "status": "running"}, 11, fence=second
        )
        if mutant:
            db._connection.execute(
                "UPDATE workflow_run_state SET owner='p1', status='complete' "
                "WHERE run_id='run-stale'"
            )
            db._connection.commit()
            stale = True
        else:
            stale = db.run_state_put(
                "run-stale", {"owner": "p1", "status": "complete"}, 12, fence=first
            )
        final = db.run_state_get("run-stale")
        db.release_run_lease("run-stale", "p2")
        third = db.acquire_run_lease("run-stale", "p3", ttl_seconds=1, now=12)
        db.release_run_lease("run-stale", "p3")
        emit(
            {
                "compression": compression,
                "fences": [first, second, third],
                "final": {"owner": final["owner"], "status": final["status"]},
                "fenceAfterRelease": db.run_fence_of("run-stale"),
                "staleAccepted": stale,
                "warnings": capture.records,
            }
        )
    finally:
        logger.removeHandler(capture)
        db.close()


def storage_types(root: Path) -> None:
    path = root / "typed.db"
    connection = sqlite3.connect(path)
    try:
        connection.execute("CREATE TABLE typed_values (id INTEGER PRIMARY KEY, n, i, r, t, b BLOB)")
        connection.execute(
            "INSERT INTO typed_values VALUES (?, ?, ?, ?, ?, ?)",
            (1, None, 42, 0.0, "café — state", bytes([0, 255, 128, 65])),
        )
        connection.commit()
        row = connection.execute(
            "SELECT n,i,r,t,b,typeof(n),typeof(i),typeof(r),typeof(t),typeof(b) FROM typed_values"
        ).fetchone()
        emit(
            {
                "classes": list(row[5:]),
                "real": row[2],
                "text": row[3],
                "blob": row[4].hex(),
            }
        )
    finally:
        connection.close()


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("state oracle driver requires an action")
    action = sys.argv[1]
    root = Path(os.environ["LOHRA_PARITY_PROFILE"])
    if action == "core":
        core(root)
    elif action == "profile-isolation":
        profile_isolation(root)
    elif action == "fts-lineage":
        fts_lineage(root)
    elif action == "locks-sequential":
        locks_sequential(root)
    elif action == "storage-types":
        storage_types(root)
    elif action == "stale-write":
        locks_sequential(root)
    else:
        raise SystemExit(f"unknown state action: {action}")


if __name__ == "__main__":
    main()
