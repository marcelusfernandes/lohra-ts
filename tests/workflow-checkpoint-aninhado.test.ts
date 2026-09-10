// Issue #243: a checkpoint inside a nested `workflow` node shares its RAW
// id with the parent's own checkpoint of the same id often enough (the
// obvious template shape — "confirm" at both levels) that answering one
// must never silently answer the other. `runCheckpoint` (engine.ts) now
// keys on a SCOPED id (`<sub_node_id>.<checkpoint_id>`, empty scope at the
// root) and refuses — never applies — a raw answer that collides with a
// checkpoint at the root scope. `MAX_WORKFLOW_DEPTH = 1` bounds the
// collision to parent<->child direct nesting, so a root spec's own
// checkpoint ids are the only ones a nested checkpoint can collide with.
//
// Issue #319: the same template reused by TWO SIBLING `workflow` nodes
// (neither the parent, both children) shares a raw id the same way — the
// root doesn't even own the id, so the pre-#319 check (root's own ids only)
// never saw the collision. `siblingAnswers` (engine-utils.ts) now collects
// every `workflow` node's own nested checkpoint ids ONCE, in `run()`,
// before any node executes — an id shared by two or more siblings is
// refused as ambiguous exactly like a root collision, and each sibling's
// SCOPED key keeps working.
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

// A leaked CHECKPOINT_AMBIGUOUS sentinel is a Symbol at ANY depth of the
// outputs tree (a raw value, or nested inside a `workflow` node's own
// output object) — recurse instead of only checking the top level.
function containsSymbol(value: unknown): boolean {
  if (typeof value === "symbol") return true;
  if (value === null || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsSymbol);
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

  it("#318: a DOTTED root checkpoint id colliding with a nested SCOPED key is refused too — never leaks the ambiguity sentinel as an output", async () => {
    // The root's OWN checkpoint id is literally "sub.confirm" — the exact
    // string the nested "sub" node's "confirm" checkpoint is scoped to.
    // `nestedCheckpointAnswers` marks ANY answers key matching a root
    // checkpoint id with the sentinel, dotted or not, so the nested engine
    // sees `{"sub.confirm": CHECKPOINT_AMBIGUOUS}` here too — the SCOPED
    // branch of `resolveCheckpoint` must refuse it exactly like the raw
    // branch does, never return it as a matched answer.
    const dottedOuterNodes = [
      { id: "sub.confirm", type: "checkpoint", prompt: "root dotted?" },
      // depends_on takes plain ids, never a "${...}" template, so the dot in
      // "sub.confirm" never has to survive `strictResolve`'s path-splitting.
      { id: "sub", type: "workflow", ref: "inner", depends_on: ["sub.confirm"] },
    ];
    const result = await new WorkflowEngine({
      runtime: new QueueChildren(),
      loader: () => innerSpec,
      checkpointAnswers: { "sub.confirm": "x" },
    }).run(spec({ meta: { name: "outer-dotted" }, nodes: dottedOuterNodes }));

    // Must never silently "complete" with the sentinel dropped by
    // `JSON.stringify` — it pauses at the nested checkpoint instead.
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("checkpoint");
    expect(result.checkpoint).toMatchObject({ node_id: "sub.confirm", prompt: "child?" });

    // #330: `node_id` here is the exact key that JUST got refused — resuming
    // with it unchanged repauses forever (it collides with the ROOT's own
    // literal id every time). `rename_hint` says so instead of letting the
    // payload look like an ordinary resumable checkpoint.
    expect((result.checkpoint as Record<string, unknown>).rename_hint).toContain("sub.confirm");

    // invariant 2: a NAMED fault, not a silent miss.
    expect(
      result.faults.some((fault) => fault.includes("collides") && fault.includes("sub.confirm")),
    ).toBe(true);

    // The root's OWN dotted checkpoint still resolves normally — colliding
    // with the CHILD's scoped form is what's refused, not the root's raw
    // answer to its own literal id.
    expect(result.outputs["sub.confirm"]).toBe("x");

    // No path anywhere emits the ambiguity sentinel itself as an output — a
    // Symbol would vanish silently through JSON instead of failing loudly.
    expect(containsSymbol(result.outputs)).toBe(false);
    const roundTripped = JSON.parse(JSON.stringify(result.outputs)) as Record<string, unknown>;
    expect(Object.keys(roundTripped).sort()).toEqual(Object.keys(result.outputs).sort());
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

// #319: neither sibling is the "parent" — the root has no checkpoint of its
// own at all — so the pre-#319 check (root's own ids only) never saw this
// collision. Both `sub1` and `sub2` load the SAME `inner` template (the
// User Story's "reuse the same template twice"), each with its own
// `confirm` checkpoint.
const siblingOuterNodes = [
  { id: "sub1", type: "workflow", ref: "inner" },
  // `depends_on` makes the root's sequential loop reach `sub1` before
  // `sub2` deterministic — `sub1`'s raw-answer refusal (and the pause that
  // follows) must not depend on `sub2` having run, or even having loaded,
  // yet: `siblingAnswers` collects both UP FRONT, before either runs.
  { id: "sub2", type: "workflow", ref: "inner", depends_on: ["sub1"] },
];

describe("checkpoint id scoping across SIBLING nested workflows — engine (#319)", () => {
  it("a raw id shared by two SIBLINGS is refused for both, never silently applied to either", async () => {
    const result = await new WorkflowEngine({
      runtime: new QueueChildren(),
      loader: () => innerSpec,
      checkpointAnswers: { confirm: "sim" },
    }).run(spec({ meta: { name: "outer-siblings" }, nodes: siblingOuterNodes }));
    // `sub1` runs first, refuses the raw id, and pauses — the root loop
    // breaks on pause, so `sub2` never even starts.
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("checkpoint");
    expect(result.checkpoint).toMatchObject({ node_id: "sub1.confirm", prompt: "child?" });
    expect(
      result.faults.some((fault) => fault.includes("collides") && fault.includes("sub1.confirm")),
    ).toBe(true);
  });

  it("each sibling's own SCOPED key resolves it independently — no cross-talk", async () => {
    const result = await new WorkflowEngine({
      runtime: new QueueChildren(),
      loader: () => innerSpec,
      checkpointAnswers: { "sub1.confirm": "a", "sub2.confirm": "b" },
    }).run(spec({ meta: { name: "outer-siblings" }, nodes: siblingOuterNodes }));
    expect(result.status).toBe("complete");
    expect(result.outputs.sub1).toEqual({ confirm: "a" });
    expect(result.outputs.sub2).toEqual({ confirm: "b" });
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
