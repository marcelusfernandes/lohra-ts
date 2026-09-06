// Issue #138 — follow-up to #125's PR #133: the `qa` report on that merge
// (2026-09-06) ran three manual mutations against the `onEvent` hook in
// `src/workflow/service.ts` (~:860-866) and found two survivors the suite
// never pinned:
//
//   (a) `event.state !== "running"` -> `true`: 2N inert writes per run (an
//       intermediate write on the node's OWN "running" start event too, not
//       only on completion) survived because every existing test reads the
//       final CONTENT of the progress line, never the CARDINALITY of the
//       writes that produced it.
//   (b) `tainted || this.taintTracker.tainted` at the call site -> `false`
//       (only on the intermediate write, never the terminal one, which uses
//       the unmutated `taintedNow`): survived because no test reads
//       `tainted` at the INSTANT of the intermediate write — only after the
//       whole run (and its unmutated terminal write) has settled.
//
// This is a NEW small file (`workflow-progress-fence.test.ts` and
// `workflow-service-durability.test.ts` are both spoken for by other
// in-flight issues — #135, #112/#129 — and the latter is already well past
// the 800-line `arquivo-grande` limit) that spies on the REAL
// `WorkflowRepository.putRunState` (no `src/**` change: `vi.spyOn` on the
// live instance, call-through) to assert cardinality and instant-of-write
// content that neither mutant satisfies.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LockRepository, openStateDatabase, WorkflowRepository } from "../src/state/index.js";
import { orchestrationMutants } from "../scripts/parity/workflow-durability/mutants-orchestration.js";
import { WorkflowService } from "../src/workflow/service.js";
import type {
  ChildResult,
  ChildRuntime,
  LeafSandboxHandle,
  LeafSandboxInstallation,
  LeafToolDispatch,
} from "../src/workflow/runtime.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** The minimal leaf sandbox a durable launch requires before any leaf can
 * spawn — same shape as `workflow-progress-fence.test.ts`. */
function withMinimalLeafSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

/** A leaf sandbox that ALSO hands back the real wrapped dispatch the
 * service installed for the run, so a leaf's `spawn` can drive a real
 * tool call (e.g. an operator-allowed `web_fetch`) through it — the same
 * path `stretchToolDispatch` gives a genuine leaf, taint tracker included.
 * Molded on `withLeafSandbox` in `tests/workflow-service-durability.test.ts`
 * (not exported there — this is the one call site this file needs). */
function withCapturedSandbox<T extends ChildRuntime>(
  runtime: T,
): T & { callThroughSandbox(name: string, args: Readonly<Record<string, unknown>>): string } {
  let dispatch: LeafToolDispatch | null = null;
  const base: LeafToolDispatch = (name) => `allowed:${name}`;
  return Object.assign(runtime, {
    installLeafSandbox: (installation: LeafSandboxInstallation): LeafSandboxHandle => {
      dispatch = installation.wrap(base);
      return {
        dispose: () => {
          dispatch = null;
        },
      };
    },
    callThroughSandbox(name: string, args: Readonly<Record<string, unknown>>): string {
      if (dispatch === null) throw new Error("no leaf sandbox installed");
      return dispatch(name, args);
    },
  });
}

describe("workflow service — progress write cardinality and taint (issue #138)", () => {
  it("persists exactly one intermediate progress write per COMPLETED node, none on start", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-progress-cobertura-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const putRunState = vi.spyOn(repository, "putRunState");
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      let leafSeq = 0;
      const runtime: ChildRuntime = withMinimalLeafSandbox({
        spawn(): string {
          leafSeq += 1;
          return `leaf-${String(leafSeq)}`;
        },
        collect: (): ChildResult => ({ status: "complete", output: { answer: "ok" }, usage }),
        steer: () => undefined,
        cancel: () => undefined,
      });
      const service = new WorkflowService({
        runtime,
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start({
        meta: { name: "progress-cobertura" },
        nodes: [
          { id: "a", type: "agent", prompt: "one" },
          { id: "b", type: "agent", prompt: "two ${a.answer}" },
        ],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      // Exactly FOUR owned writes to the run line for a two-node run: the
      // launch/registration write, one intermediate write per completed
      // node (#125 — TWO here, never on a node's own "running" start
      // event), and the terminal write. `event.state !== "running"` mutated
      // to `true` fires on BOTH of each node's events (start AND finish),
      // doubling the intermediate count to four and the total to six — this
      // exact count kills that mutant without inspecting content at all.
      expect(putRunState).toHaveBeenCalledTimes(4);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the intermediate write after a tainted leaf already carries tainted=1, before the terminal write", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-progress-cobertura-taint-"));
    roots.push(root);
    const policyPath = join(root, "workflow_policy.json");
    writeFileSync(policyPath, JSON.stringify({ egress_allow: ["docs.example.com"] }), "utf8");
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const putRunState = vi.spyOn(repository, "putRunState");
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      let leafSeq = 0;
      const runtime = withCapturedSandbox({
        spawn(): string {
          leafSeq += 1;
          if (leafSeq === 1) {
            // Node "a"'s leaf makes an OPERATOR-allowed web_fetch — a
            // tainting tool (sandbox.ts's `isTaintingTool`) — through the
            // real wrapper the service installed for this stretch, before
            // node "a" completes. By the time node "a"'s completion event
            // fires the intermediate `persistLine`, the run is already
            // tainted.
            runtime.callThroughSandbox("web_fetch", { url: "https://docs.example.com/x" });
          }
          return `leaf-${String(leafSeq)}`;
        },
        collect: (): ChildResult => ({ status: "complete", output: { answer: "ok" }, usage }),
        steer: () => undefined,
        cancel: () => undefined,
      });
      const service = new WorkflowService({
        runtime,
        policyPath,
        homeRoot: root,
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start({
        meta: { name: "progress-cobertura-taint" },
        nodes: [
          { id: "a", type: "agent", prompt: "one" },
          { id: "b", type: "agent", prompt: "two ${a.answer}" },
        ],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      // Call order for this two-node run: [0] launch/registration,
      // [1] node "a"'s OWN intermediate write, [2] node "b"'s intermediate
      // write, [3] the terminal write. Index [1] is the one this issue's
      // gap left unchecked — everyone else only ever read the FINAL state,
      // which the unmutated terminal write (`taintedNow`, untouched by this
      // mutant) makes look correct even when the intermediate write itself
      // was forced to `tainted: false`.
      expect(putRunState.mock.calls.length).toBe(4);
      // The registration write [0] happens BEFORE the leaf even spawns —
      // proof that what follows is a real false-to-true TRANSITION during
      // node "a", not a run that was already tainted from the start.
      const registration = putRunState.mock.calls[0]?.[1] as
        { readonly tainted: boolean } | undefined;
      expect(registration?.tainted).toBe(false);
      const intermediateForA = putRunState.mock.calls[1]?.[1] as
        { readonly tainted: boolean } | undefined;
      expect(intermediateForA?.tainted).toBe(true);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The two mutants above are pinned in `mutants-orchestration.ts` so
// `mutations:t16` kills them without a human running the manual mutation
// again (molded on `tests/orchestration-child-runner-mutation-catalog.test.ts`,
// #112, and the inline pin block in `tests/workflow-shutdown.test.ts`, #129):
// each `before` is asserted as EXACT, unique source text in `service.ts`, so
// a drift away from the pinned line fails `npm test` here, before the
// slower mutation harness ever runs.
const serviceSource = readFileSync(resolve(__dirname, "..", "src/workflow/service.ts"), "utf8");

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("mutations:t16 catalog pins service.ts's progress-write hook (#138)", () => {
  const PREDICATE_MUTANT_ID = "ap/progress-line-predicate-always-fires";
  const TAINT_MUTANT_ID = "aq/progress-line-tainted-forced-false-at-write";

  it(`mutants-orchestration.ts declares ${PREDICATE_MUTANT_ID}`, () => {
    const mutant = orchestrationMutants.find((candidate) => candidate.id === PREDICATE_MUTANT_ID);
    expect(mutant).toBeDefined();
  });

  it(`${PREDICATE_MUTANT_ID}'s pinned "before" occurs exactly once, verbatim, in service.ts`, () => {
    const mutant = orchestrationMutants.find((candidate) => candidate.id === PREDICATE_MUTANT_ID);
    const before = mutant?.edits[0]?.before ?? "";
    expect(before.length).toBeGreaterThan(0);
    expect(occurrences(serviceSource, before)).toBe(1);
  });

  it(`${PREDICATE_MUTANT_ID}'s focus names this file's cardinality test`, () => {
    const mutant = orchestrationMutants.find((candidate) => candidate.id === PREDICATE_MUTANT_ID);
    expect(mutant?.focus.file).toBe("tests/workflow-progress-cobertura.test.ts");
    expect(mutant?.focus.test).toBe(
      "persists exactly one intermediate progress write per COMPLETED node, none on start",
    );
  });

  it(`mutants-orchestration.ts declares ${TAINT_MUTANT_ID}`, () => {
    const mutant = orchestrationMutants.find((candidate) => candidate.id === TAINT_MUTANT_ID);
    expect(mutant).toBeDefined();
  });

  it(`${TAINT_MUTANT_ID}'s pinned "before" occurs exactly once, verbatim, in service.ts`, () => {
    const mutant = orchestrationMutants.find((candidate) => candidate.id === TAINT_MUTANT_ID);
    const before = mutant?.edits[0]?.before ?? "";
    expect(before.length).toBeGreaterThan(0);
    expect(occurrences(serviceSource, before)).toBe(1);
  });

  it(`${TAINT_MUTANT_ID}'s focus names this file's taint-instant test`, () => {
    const mutant = orchestrationMutants.find((candidate) => candidate.id === TAINT_MUTANT_ID);
    expect(mutant?.focus.file).toBe("tests/workflow-progress-cobertura.test.ts");
    expect(mutant?.focus.test).toBe(
      "the intermediate write after a tainted leaf already carries tainted=1, before the terminal write",
    );
  });
});
