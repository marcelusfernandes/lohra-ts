from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from lohra.state.db import SessionDB


def wait_for_gate(root: Path, slot: int) -> None:
    (root / f"ready-{slot}").touch()
    deadline = time.monotonic() + 10
    while not (root / "start").exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("BARRIER_TIMEOUT")
        time.sleep(0.002)


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit("usage: worker.py compression|lease <db> <barrier> <slot> <holder>")
    action, database_path, barrier_path, slot_text, holder = sys.argv[1:]
    path = Path(database_path)
    barrier = Path(barrier_path)
    slot = int(slot_text)
    db = SessionDB(str(path))
    try:
        wait_for_gate(barrier, slot)
        if action == "compression":
            token = db.acquire_compression_lock("race", holder, ttl_seconds=60)
        elif action == "lease":
            token = db.acquire_run_lease("race", holder, ttl_seconds=60, now=100)
        else:
            raise RuntimeError(f"unknown worker action: {action}")
        print(
            json.dumps(
                {
                    "runtime": "python",
                    "slot": slot,
                    "won": token is not False and token is not None,
                    "token": token,
                },
                ensure_ascii=True,
                sort_keys=True,
            )
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
