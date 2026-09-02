from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

from lohra.state.db import SessionDB


def normalize_sql(value: str | None) -> str | None:
    return None if value is None else " ".join(value.split())


def schema(connection: sqlite3.Connection) -> list[dict[str, object]]:
    return [
        {"type": row[0], "name": row[1], "table": row[2], "sql": normalize_sql(row[3])}
        for row in connection.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
        )
    ]


def write(path: Path) -> None:
    db = SessionDB(str(path))
    try:
        db.create_session("cross-parent", title="parent")
        db.create_session("cross", parent_session_id="cross-parent", model="stub-model")
        db._connection.execute(
            "UPDATE sessions SET started_at=CASE id WHEN 'cross-parent' THEN 10.0 ELSE 20.0 END"
        )
        db.save_message("cross", {"role": "user", "content": "hello cross state"})
        db.save_message(
            "cross",
            {
                "role": "assistant",
                "content": None,
                "finish_reason": "tool_calls",
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "f", "arguments": '{"a": 1}'},
                    }
                ],
                "provider_data": {"z": 2, "a": 1},
            },
        )
        db._connection.execute(
            "UPDATE messages SET timestamp=30.0+id WHERE session_id='cross'"
        )

        class Usage:
            input_tokens = 12
            output_tokens = 8
            cache_read_tokens = 0
            cache_write_tokens = 0
            reasoning_tokens = 0

        db.session_add_usage("cross", Usage(), real_usd=0.0, gross_usd=0.5, api_calls=3)
        db._connection.commit()
    finally:
        db.close()


def read(path: Path) -> dict[str, object]:
    db = SessionDB(str(path))
    try:
        usage = db.session_usage("cross")
        stored = db._connection.execute(
            "SELECT tool_calls,reasoning_details,typeof(actual_cost_usd) "
            "FROM messages JOIN sessions ON sessions.id=messages.session_id "
            "WHERE messages.role='assistant'"
        ).fetchone()
        return {
            "lineage": db.lineage_root_to_tip("cross"),
            "list": [row["id"] for row in db.list_sessions(limit=10)],
            "messages": db.load_messages("cross"),
            "schema": schema(db._connection),
            "search": db.search("hello cross"),
            "storedProviderData": stored[1],
            "storedToolCalls": stored[0],
            "usage": {
                "actual_cost_usd": usage["actual_cost_usd"],
                "api_calls": usage["api_call_count"],
                "estimated_cost_usd": usage["estimated_cost_usd"],
                "input_tokens": usage["input_tokens"],
                "output_tokens": usage["output_tokens"],
                "priced_call_count": usage["priced_call_count"],
                "storage": stored[2],
            },
        }
    finally:
        db.close()


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in {"write", "read"}:
        raise SystemExit("usage: cross-read-python.py write|read <absolute-db>")
    path = Path(sys.argv[2])
    if not path.is_absolute():
        raise SystemExit("CROSS_READ_PATH: database path must be absolute")
    path.parent.mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == "write":
        write(path)
        print(json.dumps({"written": True}, ensure_ascii=True, sort_keys=True))
    else:
        print(json.dumps(read(path), ensure_ascii=True, sort_keys=True))


if __name__ == "__main__":
    main()
