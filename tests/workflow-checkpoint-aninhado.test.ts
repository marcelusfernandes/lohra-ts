// Issue #243: a checkpoint inside a nested `workflow` node shares its RAW
// id with the parent's own checkpoint of the same id often enough (the
// obvious template shape — "confirm" at both levels) that answering one
// must never silently answer the other. `runCheckpoint` (engine.ts) now
// keys on a SCOPED id (`<sub_node_id>.<checkpoint_id>`, empty scope at the
// root) and refuses — never applies — a raw answer that collides with a
// checkpoint at the root scope. `MAX_WORKFLOW_DEPTH = 1` bounds the
// collision to parent<->child direct nesting, so a root spec's own
// checkpoint ids are the only ones a nested checkpoint can collide with.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LockRepository, openStateDatabase, WorkflowRepository } from "../src/state/index.js";
import {
  CHECKPOINT_HINT,
  validateSpec,
  WorkflowEngine,
  WorkflowService,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
  type LeafSandboxHandle,
} from "../src/workflow/index.js";

class QueueChildren implements ChildRuntime {
  readonly requests: ChildSpawnRequest[] = [];

  spawn(request: ChildSpawnRequest): string {
    this.requests.push(request);
    return `leaf-${String(this.requests.length)}`;
  }

  collect(_id: string, _options: ChildCollectOptions): ChildResult {
    return { status: "failed", output: "no leaf expected in these specs" };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): LeafSandboxHandle {
    return { dispose: (): void => undefined };
  }
}

function spec(raw: unknown) {
  const parsed = validateSpec(raw);
  if ("issues" in parsed) throw new Error(parsed.message);
  return parsed;
}

// Both levels name their checkpoint "confirm" — the exact shape #243 guards.
const innerSpec = {
  meta: { name: "inner" },
  nodes: [{ id: "confirm", type: "checkpoint", prompt: "child?" }],
};
const outerNodes = (extra: Record<string, unknown> = {}) => [
  { id: "confirm", type: "checkpoint", prompt: "root?" },
  { id: "sub", type: "workflow", ref: "inner", depends_on: ["confirm"], ...extra },
];

describe("checkpoint id scoping in a nested workflow — engine (#243)", () => {
  it("a collision resolves through SCOPED keys: parent and child get their own distinct answer", async () => {
    const result = await new WorkflowEngine({
      runtime: new QueueChildren(),
      loader: () => innerSpec,
      checkpointAnswers: { confirm: "root-answer", "sub.confirm": "child-answer" },
    }).run(spec({ meta: { name: "outer" }, nodes: outerNodes() }));
    expect(result.status).toBe("complete");
    expect(result.outputs.confirm).toBe("root-answer");
    expect(result.outputs.sub).toEqual({ confirm: "child-answer" });
  });

  it("a raw id shared with the parent is refused for the child, never silently applied", async () => {
    const result = await new WorkflowEngine({
      runtime: new QueueChildren(),
      loader: () => innerSpec,
      checkpointAnswers: { confirm: "sim" },
    }).run(spec({ meta: { name: "outer" }, nodes: outerNodes() }));
    // the PARENT's own checkpoint still resolves — the raw id is genuinely
    // its own, unscoped at the root.
    expect(result.outputs.confirm).toBe("sim");
    // the CHILD never receives it: it pauses instead of completing with
    // "sim" too (the pre-#243 bug: one flat answer satisfied both).
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("checkpoint");
    expect(result.checkpoint).toMatchObject({ node_id: "sub.confirm", prompt: "child?" });
    // invariant 2: the collision is a NAMED fault, not a silent miss.
    expect(
      result.faults.some((fault) => fault.includes("collides") && fault.includes("sub.confirm")),
    ).toBe(true);
  });

  it("a raw id with NO collision keeps working — pre-#243 compat", async () => {
    const result = await new WorkflowEngine({
      runtime: new QueueChildren(),
      loader: () => innerSpec,
      checkpointAnswers: { confirm: "x" },
    }).run(
      spec({
        meta: { name: "outer-no-root-checkpoint" },
        nodes: [{ id: "sub", type: "workflow", ref: "inner" }],
      }),
    );
    expect(result.status).toBe("complete");
    expect(result.outputs.sub).toEqual({ confirm: "x" });
  });
});

describe("CHECKPOINT_HINT names the scoped form (#243)", () => {
  it("mentions the dotted scoped id, not just the bare node id", () => {
    expect(CHECKPOINT_HINT).toContain("sub.confirm");
  });
});

const workflowResumeRoots: string[] = [];

afterEach(() => {
  while (workflowResumeRoots.length > 0)
    rmSync(workflowResumeRoots.pop() as string, { recursive: true, force: true });
});

function workflowResumeRoot(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  workflowResumeRoots.push(path);
  return path;
}

function durableWorkflowService(
  home: string,
  runtime: ChildRuntime,
): { readonly service: WorkflowService; readonly close: () => void } {
  const connection = openStateDatabase(join(home, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const service = new WorkflowService({
    runtime,
    homeRoot: home,
    loader: () => innerSpec,
    store: {
      repository,
      locks,
      holder: "test",
      ttl: 900,
      ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
      database: connection.database,
    },
  });
  return {
    service,
    close: () => {
      connection.close();
    },
  };
}

describe("checkpoint id scoping across a durable resume — service (#243)", () => {
  it("refuses a raw answer that collides with the parent's checkpoint, names it, never applies it", async () => {
    const home = workflowResumeRoot("lohra-checkpoint-aninhado-");
    const { service, close } = durableWorkflowService(home, new QueueChildren());
    try {
      const started = service.start(
        { meta: { name: "outer" }, nodes: outerNodes() },
        {},
        { checkpointAnswers: { confirm: "sim" } },
      );
      if ("error" in started) throw new Error(started.error);
      const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(paused.status).toBe("paused");
      expect(paused.checkpoint).toMatchObject({ node_id: "sub.confirm" });

      // resuming with the RAW id again is refused — a named error, not a
      // silent (wrong) application.
      const wrongResume = service.start(
        null,
        {},
        { resumeRunId: started.run_id, checkpointAnswers: { confirm: "still-wrong" } },
      );
      expect("error" in wrongResume).toBe(true);
      if (!("error" in wrongResume)) throw new Error("expected a named error");
      expect(wrongResume.error).toContain("sub.confirm");

      // the run is still paused at the SAME checkpoint — nothing applied.
      const stillPaused = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(stillPaused.status).toBe("paused");
      expect(stillPaused.checkpoint).toMatchObject({ node_id: "sub.confirm" });

      // the correctly SCOPED key resumes it for real.
      const resumed = service.start(
        null,
        {},
        { resumeRunId: started.run_id, checkpointAnswers: { "sub.confirm": "child-answer" } },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      expect((final.outputs as Record<string, unknown>).confirm).toBe("sim");
      expect((final.outputs as Record<string, unknown>).sub).toEqual({ confirm: "child-answer" });
    } finally {
      close();
    }
  });
});
