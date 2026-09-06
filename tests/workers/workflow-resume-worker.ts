// Process C of the cross-process durability proof (issue #103). Resumes the
// run process A abandoned mid-flight (`resume_run_id`), against a FRESH
// `OrchestrationCore`/runtime with its own spawn counter — the counter is
// the whole point: node "first" was already cached durably by process A, so
// a correct resume calls its `runChild` zero times for it and exactly once
// for node "second" (never executed before the kill). Prints the counts and
// the final published result as one JSON line, then shuts down cleanly.
import { openStateDatabase } from "../../src/state/connection.js";
import type { ChildRunner } from "../../src/orchestration/core.js";
import { OrchestrationCore } from "../../src/orchestration/core.js";
import { OrchestrationChildRuntime } from "../../src/workflow/orchestration-runtime.js";
import { productionOwnershipStore } from "../../src/workflow/ownership-store.js";
import { WorkflowService } from "../../src/workflow/service.js";
import { completeResult, crossProcessSpec } from "./workflow-cross-process-fixtures.js";

const [databasePath, homeRoot, resumeRunId, nowArg] = process.argv.slice(2);
if (
  databasePath === undefined ||
  homeRoot === undefined ||
  resumeRunId === undefined ||
  nowArg === undefined
) {
  throw new Error("usage: workflow-resume-worker.ts <databasePath> <homeRoot> <resumeRunId> <now>");
}
const now = Number(nowArg);
// Narrowed to a plain `string` here — TS does not retain the argv guard's
// narrowing across the `main()` closure below.
const resumeRunIdChecked: string = resumeRunId;

const spawnCounts: Record<string, number> = {};
const runChild: ChildRunner = (_subId, config) => {
  spawnCounts[config.prompt] = (spawnCounts[config.prompt] ?? 0) + 1;
  return Promise.resolve(completeResult(`${config.prompt}-resumed`));
};

const core = new OrchestrationCore({
  runChild,
  idSource: (() => {
    let n = 0;
    return () => {
      n += 1;
      return `resume-leaf-${String(n)}`;
    };
  })(),
  maxSubsessions: 100,
  maxParallel: 10,
  buildSubagentPrompt: () => "SYS",
});

const connection = openStateDatabase(databasePath);
const service = new WorkflowService({
  runtime: new OrchestrationChildRuntime(core),
  store: productionOwnershipStore(connection.database, { now: () => now }),
  homeRoot,
});

async function main(): Promise<void> {
  // Same spec object as process A (`crossProcessSpec()`, imported, never
  // hand-copied) — `resumeRunId` alone would also read the spec back off
  // `workflow_run_state.spec_json`, but passing it explicitly matches the
  // precedent in `tests/workflow-shutdown.test.ts` and removes any doubt
  // about whether the cache hash lines up.
  const started = service.start(crossProcessSpec(), {}, { resumeRunId: resumeRunIdChecked });
  if ("error" in started) {
    process.stdout.write(`${JSON.stringify({ error: started.error, spawnCounts })}\n`);
    await service.shutdown();
    connection.close();
    process.exit(1);
  }
  const result = await service.status(started.run_id, true);
  await service.shutdown();
  connection.close();
  process.stdout.write(`${JSON.stringify({ result, spawnCounts })}\n`);
}

void main();
