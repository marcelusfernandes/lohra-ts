import { appendFileSync, existsSync } from "node:fs";

import { withCronStoreGuard } from "../../src/cron/store-guard.js";

const [path, mode, releasePath, eventsPath, label] = process.argv.slice(2);
if (!path || !mode || !releasePath || !eventsPath || !label) {
  throw new Error("worker arguments missing");
}

process.stdout.write("READY\n");
try {
  withCronStoreGuard(path, () => {
    appendFileSync(eventsPath, `ENTER-${label}\n`);
    process.stdout.write("ENTER\n");
    if (mode === "hold") {
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(releasePath)) Atomics.wait(sleeper, 0, 0, 20);
    }
    if (mode === "throw") throw new Error("CALLBACK_SENTINEL");
    appendFileSync(eventsPath, `EXIT-${label}\n`);
  });
  process.stdout.write("DONE\n");
} catch (error) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const causeCode =
    cause && "code" in cause && typeof cause.code === "string" ? cause.code : "none";
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}; cause=${cause?.message ?? "none"}; code=${causeCode}\n`,
  );
  process.exitCode = 2;
}
