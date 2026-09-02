"""Real process for the [cli-bilateral] `cronjob` tool scenarios (decision
10): builds the SAME registry/compose_dispatch wiring `lohra.agent.equip`
uses for a real conversation turn (`register_all_tools()` +
`build_session_dispatch(cron_store=...)`), then dispatches one `cronjob`
call and prints the raw envelope string to stdout. Args come in as a JSON
blob on argv[1] so the harness can drive add/list/remove/pause/resume
uniformly against both sides with the same shape.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from lohra.agent.equip import build_session_dispatch, register_all_tools
from lohra.cron.store import CronStore
from lohra.memory.store import MemoryStore
from lohra.skills.store import SkillStore

register_all_tools()

home = Path(sys.argv[1])
args = json.loads(sys.argv[2])

cron_store = CronStore(home)
dispatch = build_session_dispatch(
    memory_store=MemoryStore(home),
    skill_store=SkillStore(home),
    cron_store=cron_store,
)
result = dispatch("cronjob", args)
sys.stdout.write(result)
