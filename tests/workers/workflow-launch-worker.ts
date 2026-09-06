// Process A of the cross-process durability proof (issue #103). Launches a
// durable workflow run — the exact composition `chat.ts`/`dashboard.ts` use
// (`productionOwnershipStore` over the caller's own connection +
// `OrchestrationChildRuntime` over a real `OrchestrationCore`, PR #115) —
// against the `state.db` given on argv, then never calls `shutdown()`: the
// parent test process SIGKILLs this one on purpose, mid-flight, to prove the
// run survives the process rather than the shutdown path.
//
// Imports straight from `../../src/...` via `tsx` (never `dist/`), same mold
// as `tests/parity/stub-driver.test.ts` — this file must run without a build.
import { AuditRepository } from "../../src/state/audit-repository.js";
import { openStateDatabase } from "../../src/state/connection.js";
import type { ChildRunner } from "../../src/orchestration/core.js";
import { OrchestrationCore } from "../../src/orchestration/core.js";
import { AuditTrail } from "../../src/workflow/audit-trail.js";
import { OrchestrationChildRuntime } from "../../src/workflow/orchestration-runtime.js";
import { productionOwnershipStore } from "../../src/workflow/ownership-store.js";
import { WorkflowService } from "../../src/workflow/service.js";
import {
  completeResult,
  crossProcessSpec,
  PROMPT_FIRST,
} from "./workflow-cross-process-fixtures.js";

const [databasePath, homeRoot, nowArg] = process.argv.slice(2);
if (databasePath === undefined || homeRoot === undefined || nowArg === undefined) {
  throw new Error("usage: workflow-launch-worker.ts <databasePath> <homeRoot> <now>");
}
const now = Number(nowArg);

// Keeps the event loop alive independent of any library timer's ref-ness
// (the production heartbeat timer is real but its interval — RUN_LEASE_TTL/3
// — is far longer than this process's life). Never cleared: this worker is
// only ever ended by an external SIGKILL.
setInterval(() => undefined, 1_000_000);

const connection = openStateDatabase(databasePath);
const auditTrail = new AuditTrail(new AuditRepository(connection.database));

const runChild: ChildRunner = (_subId, config) => {
  if (config.prompt === PROMPT_FIRST) {
    return Promise.resolve(completeResult("first output"));
  }
  // The second leaf: never resolves — it is "in flight" for as long as this
  // process lives. Signals readiness only once the FIRST cell's cache write
  // (and its audit trail) already landed durably, so the parent never kills
  // this process before there is something durable to prove.
  return new Promise(() => {
    void auditTrail.flush().then(() => {
      process.stdout.write(`READY\n`);
    });
  });
};

const core = new OrchestrationCore({
  runChild,
  idSource: (() => {
    let n = 0;
    return () => {
      n += 1;
      return `leaf-${String(n)}`;
    };
  })(),
  maxSubsessions: 100,
  maxParallel: 10,
  buildSubagentPrompt: () => "SYS",
});

const service = new WorkflowService({
  runtime: new OrchestrationChildRuntime(core),
  store: productionOwnershipStore(connection.database, { now: () => now }),
  auditTrail,
  homeRoot,
});

const started = service.start(crossProcessSpec(), {});
if ("error" in started) {
  process.stderr.write(`START_FAILED ${started.error}\n`);
  process.exit(1);
}
process.stdout.write(`RUN_ID ${started.run_id}\n`);
// Deliberately never calls service.shutdown() or connection.close(): the
// parent kills this process with SIGKILL while the second leaf is in flight.
