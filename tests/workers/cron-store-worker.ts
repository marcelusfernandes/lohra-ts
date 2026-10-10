import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CronStore } from "../../src/cron/store.js";
import { withCronStoreGuard } from "../../src/cron/store-guard.js";

const [mode, home, ready, release] = process.argv.slice(2);
if (!mode || !home || !ready || !release) throw new Error("worker arguments missing");
const releasePath = release;
const jobs = `${home}/cron/jobs.json`;
const store = new CronStore(home);

function waitForRelease(): void {
  const deadline = Date.now() + 15_000;
  while (!existsSync(releasePath)) {
    if (Date.now() > deadline) throw new Error("release barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

try {
  if (mode === "hold" || mode === "hold-after-rename") {
    withCronStoreGuard(jobs, () => {
      if (mode === "hold-after-rename") {
        const raw = readFileSync(jobs, "utf8");
        const parsed = JSON.parse(raw) as { jobs: Record<string, unknown>[] };
        const tmp = `${jobs}.${String(process.pid)}.tmp`;
        writeFileSync(
          tmp,
          JSON.stringify({ jobs: [...parsed.jobs, { ...parsed.jobs[0], id: "after-rename" }] }),
        );
        renameSync(tmp, jobs);
      }
      writeFileSync(ready, String(process.pid));
      waitForRelease();
    });
  } else if (mode === "add") {
    writeFileSync(ready, String(process.pid));
    waitForRelease();
    store.add({ name: String(process.pid), prompt: "p", type: "interval", value: 5 });
  } else if (mode === "list") {
    mkdirSync(dirname(ready), { recursive: true });
    writeFileSync(ready, String(process.pid));
    store.list();
  } else {
    throw new Error(`unknown worker mode ${mode}`);
  }
} catch (error) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const code = cause && "code" in cause ? String(cause.code) : "none";
  process.stderr.write(`${String(error)} cause=${cause ? String(cause) : "none"} code=${code}\n`);
  process.exitCode = 2;
}
