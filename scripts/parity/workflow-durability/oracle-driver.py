#!/usr/bin/env python3
"""T16 oracle driver — offline measurement of lease/fence/run-state semantics.

Read-only w.r.t. the oracle repo (pinned SHA enforced by run-all.ts). Every
write lands in a temp dir; the clock is injected so nothing sleeps. No network.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile

from lohra.state.db import SessionDB
from lohra.workflow.fencing import EVICTED
from lohra.workflow.runstate_store import RunStateStore

CLOCK = {"now": 1000.0}


def store(holder: str, ttl: float = 900.0) -> RunStateStore:
    return RunStateStore(db, holder=holder, clock=lambda: CLOCK["now"], ttl=ttl)


def step(name: str, value: object) -> None:
    OUT.append({"step": name, "value": value})


OUT: list[dict] = []
tmp = tempfile.mkdtemp(prefix="lohra-t16-oracle-")
db = SessionDB(os.path.join(tmp, "session.db"))

master = db._connection.execute(
    "SELECT name, sql FROM sqlite_master WHERE name IN "
    "('workflow_node_cache','workflow_node_cost','workflow_run_spend',"
    "'workflow_run_state','workflow_run_locks','workflow_run_fence') ORDER BY name"
).fetchall()
step("ddl", {r["name"]: r["sql"] for r in master})

a = store("proc-a")
b = store("proc-b")

step("acquire_first", a.acquire("run-1"))
step("fence_after_first", a.fence_of("run-1"))
step("acquire_second_live", b.acquire("run-1"))
loser_fence = b.fence_of("run-1")
step("fence_of_loser_evicted", loser_fence is EVICTED)
step("lease_expiry", a.lease_expiry("run-1"))

step("write_owner_live", a.save(run_id="run-1", name="n", status="running",
                                spec={"meta": {"name": "n"}}, args={}))
step("write_evicted_refused", b.save(run_id="run-1", status="running"))
step("renew_by_owner", a.renew("run-1", force=True))

a.release("run-1")
step("db_fence_after_release", db.run_fence_of("run-1"))
step("acquire_after_release", b.acquire("run-1"))
step("fence_after_reacquire", b.fence_of("run-1"))
step("stale_owner_write_refused", a.save(run_id="run-1", status="complete"))
step("state_after_stale_write", (db.run_state_get("run-1") or {}).get("status"))

# expired lease: nobody may renew, expiry reads None, is_stale flips
CLOCK["now"] = 1000.0 + 901.0
step("renew_after_expiry", b.renew("run-1", force=True))
step("expiry_after_ttl", b.lease_expiry("run-1"))

stranger = store("proc-a3")
step("cancel_missing", stranger.mark_cancelled("nope"))
row_b = b.load("run-1")
step("is_stale_running_no_lease", b.is_stale(row_b))

# run ledger + node cache + cost (unfenced baseline writes, then fenced refusal)
step("spend_put", db.run_spend_put("run-1", 100, 10, 5, fence=b.fence_of("run-1")))
step("spend_row", db.run_spend_get("run-1"))
fence_now = db.run_fence_of("run-1")
step("cache_put_owned", db.cache_put("run-1", "h1", "node", "{}", "complete", fence=fence_now))
step("cache_put_stale", db.cache_put("run-1", "h2", "node", "{}", "complete", fence=(fence_now or 0) - 1))
step("cache_h2_absent", db.cache_get("run-1", "h2"))

db.close()
sys.stderr.write(f"oracle temp dir: {tmp}\n")
print(json.dumps(OUT, sort_keys=True, default=str))
