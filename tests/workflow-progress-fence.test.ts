// Issue #125: progress_json is now persisted after EVERY completed node
// (service.ts's `persistLine`, hooked off the engine's "node" events), not
// only at the terminal write. This is a NEW small file rather than another
// addition to tests/workflow-service-durability.test.ts (already well over
// the 800-line `arquivo-grande` limit — growing it further would fail the
// `contratos` check; the issue's own text anticipated this: "arquivo novo
// pequeno").
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase } from "../src/state/index.js";
import type { StateWarning } from "../src/state/index.js";
import { productionOwnershipStore } from "../src/workflow/ownership-store.js";
import { WorkflowService } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime, LeafSandboxHandle } from "../src/workflow/runtime.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** The minimal leaf sandbox a durable launch requires before any leaf can
 * spawn (service.ts refuses fail-closed without it) — no tool dispatch is
 * exercised by these two nodes, so there is nothing to wrap. */
function withMinimalLeafSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

describe("workflow service — progress persisted per node (issue #125)", () => {
  it("a node's own progress write is fenced: a stale acquisition never overwrites the line", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-progress-fence-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      // Issue #135: the sink is threaded through `productionOwnershipStore`
      // (not a bare `new WorkflowRepository(...)`, which defaults to a
      // no-op) — that's the actual composition chat.ts/dashboard.ts use.
      const warnings: StateWarning[] = [];
      let clock = 1000;
      const store = productionOwnershipStore(connection.database, {
        holder: "test",
        now: () => clock,
        warning: (warning) => warnings.push(warning),
      });
      let leafSeq = 0;
      const runtime: ChildRuntime = withMinimalLeafSandbox({
        spawn(): string {
          leafSeq += 1;
          // node "b"'s leaf spawns after node "a" already completed and its
          // OWN progress write landed under a live lease; push the clock
          // past the 900s TTL so "b"'s progress write (and the terminal
          // write after it) both present a stale token and are refused.
          if (leafSeq === 2) clock = 1000 + 901;
          return `leaf-${String(leafSeq)}`;
        },
        collect: (): ChildResult => ({
          status: "complete",
          output: { answer: "ok" },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      });
      const service = new WorkflowService({
        runtime,
        // no live timers: only the per-cell top-up could renew the lease,
        // and node "b"'s own top-up attempt is itself refused past the TTL
        timerFactory: () => ({ cancel: () => undefined }),
        store,
      });
      const started = service.start({
        meta: { name: "progress-fence" },
        nodes: [
          { id: "a", type: "agent", prompt: "one" },
          { id: "b", type: "agent", prompt: "two ${a.answer}" },
        ],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const line = store.repository.getRunState(started.run_id) as Record<string, unknown>;
      // "a"'s progress write landed (done=1); "b"'s own progress write and
      // the terminal write were both refused — the line never advances past
      // what the last LIVE acquisition wrote, and status stays "running"
      // (never overwritten with a stale "complete").
      const progress = JSON.parse(String(line.progress_json)) as { total: number; done: number };
      expect(progress.total).toBe(2);
      expect(progress.done).toBe(1);
      expect(line.status).toBe("running");
      // Issue #135: the refusal is no longer silent — the sink registered
      // on the production store's repository sees every STALE_FENCE_WRITE
      // the stale acquisition triggers (node "b"'s own progress write, and
      // the terminal write attempted after it).
      expect(warnings.length).toBeGreaterThan(0);
      for (const warning of warnings) {
        expect(warning.cause).toBe("STALE_FENCE_WRITE");
        expect(warning.runId).toBe(started.run_id);
      }
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
