import { existsSync, writeFileSync } from "node:fs";

import { tick } from "../../src/cron/scheduler.js";
import { CronStore } from "../../src/cron/store.js";

const [mode, home, ready, start, gate, gateRelease, result] = process.argv.slice(2);
if (!mode || !home || !ready || !start || !gate || !gateRelease || !result) {
  throw new Error("scheduler worker arguments missing");
}

function waitFor(path: string): void {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`scheduler barrier timed out: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

try {
  const store = new CronStore(home);
  if (mode === "before-claim") {
    const originalList = store.list.bind(store);
    store.list = () => {
      const candidates = originalList();
      writeFileSync(gate, "listed");
      waitFor(gateRelease);
      return candidates;
    };
  } else if (mode === "after-commit") {
    const originalClaim = store.tryClaimDue.bind(store);
    store.tryClaimDue = (id, now) => {
      const claimed = originalClaim(id, now);
      if (claimed !== null) {
        writeFileSync(gate, "committed");
        waitFor(gateRelease);
      }
      return claimed;
    };
  } else if (mode !== "run" && mode !== "during-callback") {
    throw new Error(`unknown scheduler worker mode ${mode}`);
  }

  writeFileSync(ready, String(process.pid));
  waitFor(start);
  let callbacks = 0;
  const results = await tick(
    store,
    () => {
      callbacks += 1;
      if (mode === "during-callback") {
        writeFileSync(gate, "callback-started");
        waitFor(gateRelease);
      }
      return Promise.resolve();
    },
    { now: 100 },
  );
  writeFileSync(result, JSON.stringify({ callbacks, results }));
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 2;
}
