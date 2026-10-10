import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withCronStoreGuard } from "../../src/cron/store-guard.js";
import { CronStore } from "../../src/cron/store.js";

const [mode, home, jobId, nowText, ready, release, result] = process.argv.slice(2);
if (!mode || !home || !jobId || !nowText || !ready || !release || !result) {
  throw new Error("claim worker arguments missing");
}
const releasePath = release;

function waitForRelease(): void {
  const deadline = Date.now() + 15_000;
  while (!existsSync(releasePath)) {
    if (Date.now() > deadline) throw new Error("claim release barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

try {
  if (mode === "hold-guard") {
    withCronStoreGuard(join(home, "cron", "jobs.json"), () => {
      writeFileSync(ready, String(process.pid));
      waitForRelease();
    });
  } else {
    if (mode !== "claim-after-release" && mode !== "claim-then-hold" && mode !== "blocked") {
      throw new Error(`unknown claim worker mode ${mode}`);
    }
    if (mode !== "claim-then-hold") writeFileSync(ready, String(process.pid));
    if (mode === "claim-after-release") waitForRelease();
    const claimed = new CronStore(home).tryClaimDue(jobId, Number(nowText));
    writeFileSync(
      result,
      JSON.stringify({ winner: claimed !== null, lastRun: claimed?.last_run_at ?? null }),
    );
    if (mode === "claim-then-hold") {
      writeFileSync(ready, String(process.pid));
      waitForRelease();
    }
  }
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 2;
}
