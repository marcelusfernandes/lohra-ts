import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestrationCore,
  type ChildRunner,
  type CollectResult,
} from "../src/orchestration/core.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import type {
  CausalContext,
  ChildSpawnRequest,
  LeafToolDispatch,
} from "../src/workflow/runtime.js";
import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { TaintTracker } from "../src/workflow/sandbox.js";
import { WorkflowService } from "../src/workflow/service.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** Mirrors `ChildToolDispatch` from core.ts structurally, so these tests
 * never need to import the internal type. */
type ChildToolDispatch = (name: string, args: Readonly<Record<string, unknown>>) => Promise<string>;
type WrapDispatch = (base: ChildToolDispatch) => ChildToolDispatch;

function ok(output: string): CollectResult {
  return {
    status: "complete",
    output,
    tokensIn: 1,
    tokensOut: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    provider: "test",
    model: "test-model",
    forcedFallback: false,
    errorKind: null,
    retryAfter: null,
  };
}

function makeCore(runChild: ChildRunner): OrchestrationCore {
  let n = 0;
  return new OrchestrationCore({
    runChild,
    idSource: () => {
      n += 1;
      return `leaf-${String(n)}`;
    },
    maxSubsessions: 100,
    maxParallel: 10,
    buildSubagentPrompt: () => "SYS",
  });
}

function causal(runId: string): CausalContext {
  return Object.freeze({
    runId,
    segmentId: "seg-1",
    nodePath: Object.freeze(["a"]),
    cellId: "a:0",
    role: "leaf",
    attempt: 0,
    turn: 0,
  });
}

function spawnRequest(runId: string, prompt = "do it"): ChildSpawnRequest {
  return { prompt, causalContext: causal(runId) };
}

describe("OrchestrationChildRuntime — leaf sandbox installation", () => {
  it("installs by runId and dispose() removes only its own fence (a later fence stays live)", async () => {
    const captured: (WrapDispatch | undefined)[] = [];
    const runChild: ChildRunner = (_subId, config) => {
      captured.push(config.wrapDispatch);
      return Promise.resolve(ok("done"));
    };
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    const tagCalls: string[] = [];
    // A real sandbox wrap only inspects name/args and returns base's result
    // UNCHANGED when it doesn't deny — the sync/async shim's pending token
    // has to survive untouched through it, so this test wrap records which
    // fence ran via a side channel instead of transforming the string.
    const tagWrap =
      (tag: string): ((base: LeafToolDispatch) => LeafToolDispatch) =>
      (base) =>
      (name, args) => {
        tagCalls.push(`${tag}:${name}`);
        return base(name, args);
      };

    const handle1 = runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: tagWrap("A") });
    const handle2 = runtime.installLeafSandbox({ runId: "r1", fence: 2, wrap: tagWrap("B") });
    // dispose from the OLDER fence must not touch the newer, still-live install
    handle1.dispose();

    const id1 = runtime.spawn(spawnRequest("r1"));
    // ConcurrencyGate.run() awaits an already-resolved promise before
    // calling runChild, so it only actually runs on a later microtask —
    // collect(wait:true) is the honest way to wait for that.
    await runtime.collect(id1, { wait: true, timeoutSeconds: 5 });
    const wrapDispatch = captured[0];
    if (wrapDispatch === undefined) throw new Error("wrapDispatch missing");
    const base: ChildToolDispatch = (name) => Promise.resolve(`base:${name}`);
    await expect(wrapDispatch(base)("read_file", {})).resolves.toBe("base:read_file");
    // fence 2 (B), not fence 1 (A), ran — dispose(fence 1) was a no-op
    expect(tagCalls).toEqual(["B:read_file"]);

    // now retire the still-live fence 2 install: a later spawn gets nothing
    handle2.dispose();
    const id2 = runtime.spawn(spawnRequest("r1"));
    await runtime.collect(id2, { wait: true, timeoutSeconds: 5 });
    const secondWrapDispatch = captured[1];
    if (secondWrapDispatch === undefined) throw new Error("second wrapDispatch missing");
    const secondBaseCalls: string[] = [];
    const secondBase: ChildToolDispatch = (name) => {
      secondBaseCalls.push(name);
      return Promise.resolve(`base:${name}`);
    };
    const out = await secondWrapDispatch(secondBase)("read_file", {});
    expect(out).toMatch(/^ERROR: /);
    expect(secondBaseCalls).toEqual([]);
  });
});

describe("OrchestrationChildRuntime — fail-closed without a live installation", () => {
  it("a spawn whose causalContext.runId has no installation never dispatches a tool without a sandbox", async () => {
    let captured: WrapDispatch | undefined;
    const runChild: ChildRunner = (_subId, config) => {
      captured = config.wrapDispatch;
      return Promise.resolve(ok("done"));
    };
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));

    // no installLeafSandbox call at all for this runId
    const id = runtime.spawn(spawnRequest("orphan-run"));
    await runtime.collect(id, { wait: true, timeoutSeconds: 5 });
    if (captured === undefined) throw new Error("wrapDispatch missing");
    const baseCalls: string[] = [];
    const base: ChildToolDispatch = (name) => {
      baseCalls.push(name);
      return Promise.resolve(`should-not-happen:${name}`);
    };
    const out = await captured(base)("write_file", { path: "/tmp/x" });
    expect(out).toMatch(/^ERROR: /);
    expect(baseCalls).toEqual([]);
  });
});

describe("OrchestrationChildRuntime — steer keeps the original wrap", () => {
  it("a steer-driven resurrection dispatches through the SAME wrap installed at spawn time", async () => {
    const seen: string[] = [];
    const runChild: ChildRunner = async (_subId, config) => {
      const base: ChildToolDispatch = (name) => {
        seen.push(name);
        return Promise.resolve(`allowed:${name}`);
      };
      const dispatch = config.wrapDispatch === undefined ? base : config.wrapDispatch(base);
      const out = await dispatch("read_file", {});
      seen.push(out);
      return ok(out);
    };
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    const wrapCalls: string[] = [];
    // A real sandbox wrap (sandboxDispatch/taintWrap/stretchToolDispatch)
    // only inspects name/args and returns base's result UNCHANGED when it
    // doesn't deny — the sync/async shim's pending token has to survive
    // untouched through it, so this test wrap mirrors that instead of
    // transforming the string (which would break the shim, not this test).
    const wrap: (base: LeafToolDispatch) => LeafToolDispatch = (base) => (name, args) => {
      wrapCalls.push(name);
      return base(name, args);
    };
    runtime.installLeafSandbox({ runId: "r-steer", fence: 1, wrap });

    const id = runtime.spawn(spawnRequest("r-steer"));
    const first = await runtime.collect(id, { wait: true, timeoutSeconds: 5 });
    expect(first.output).toBe("allowed:read_file");
    expect(wrapCalls).toEqual(["read_file"]);

    // resurrect via steer — no causalContext passed, mirroring the real
    // ChildRuntime.steer(id, prompt) call; the wrap must still come from the
    // ORIGINAL spawn's config, per core.ts's steer() resurrection (it spreads
    // entry.originalConfig, which already carries wrapDispatch).
    runtime.steer(id, "again");
    const second = await runtime.collect(id, { wait: true, timeoutSeconds: 5 });
    expect(second.output).toBe("allowed:read_file");
    // the SAME wrap (not a fresh one, and not the raw base) ran again
    expect(wrapCalls).toEqual(["read_file", "read_file"]);
  });
});

function policyFile(root: string, body: Record<string, unknown>): string {
  const path = join(root, "workflow_policy.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

function spec(): Record<string, unknown> {
  return {
    meta: { name: "durable" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}

describe("OrchestrationChildRuntime — end to end with a real WorkflowService", () => {
  it("a durable launch with OrchestrationChildRuntime does not refuse LEAF_SANDBOX_UNAVAILABLE, enforces the operator sandbox, and denies a retired stretch's wrapper", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-orchestration-runtime-"));
    roots.push(root);
    const readOnlyRoot = join(root, "reference");
    mkdirSync(readOnlyRoot, { recursive: true });
    const policyPath = policyFile(root, {
      fs_allow: [{ path: readOnlyRoot, mode: "ro" }],
      egress_allow: ["docs.example.com"],
    });
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const tracker = new TaintTracker();

      let spawns = 0;
      // Set right after service.start() returns, below — read only once the
      // FIRST leaf's runChild call actually runs, which core.ts's spawn()
      // only starts asynchronously (never inside start()'s own call frame),
      // so this is always populated by the time runChild reads it.
      let workingRoot1 = "";
      let runId1 = "";
      let firstWrapDispatch: WrapDispatch | undefined;
      const leaf1BaseCalls: string[] = [];
      const stepResults: { step: string; out: string }[] = [];
      let openSecondLeaf!: () => void;
      const secondLeafGate = new Promise<void>((resolveGate) => {
        openSecondLeaf = resolveGate;
      });

      const runChild: ChildRunner = async (_subId, config) => {
        spawns += 1;
        const index = spawns;
        if (index === 1) {
          firstWrapDispatch = config.wrapDispatch;
          const base: ChildToolDispatch = (name) => {
            leaf1BaseCalls.push(name);
            return Promise.resolve(`allowed:${name}`);
          };
          const dispatch = config.wrapDispatch === undefined ? base : config.wrapDispatch(base);
          const workingRoot = workingRoot1;
          mkdirSync(workingRoot, { recursive: true });
          const step = async (
            label: string,
            name: string,
            args: Readonly<Record<string, unknown>>,
          ): Promise<void> => {
            stepResults.push({ step: label, out: await dispatch(name, args) });
          };
          await step("inside-working-root", "write_file", { path: join(workingRoot, "note.txt") });
          await step("outside-every-root", "read_file", { path: join(root, "elsewhere.txt") });
          await step("ro-root-read", "read_file", { path: join(readOnlyRoot, "a.txt") });
          await step("ro-root-write", "write_file", { path: join(readOnlyRoot, "a.txt") });
          await step("egress-denied", "web_fetch", { url: "https://evil.example.com/x" });
          stepResults.push({ step: "taint-before", out: String(tracker.tainted) });
          await step("egress-allowed", "web_fetch", { url: "https://DOCS.example.com/x" });
          stepResults.push({ step: "taint-after", out: String(tracker.tainted) });
          await step("tainted-fs", "read_file", { path: join(readOnlyRoot, "a.txt") });
          await step("tainted-egress", "web_fetch", { url: "https://docs.example.com/x" });
          return ok("leaf-1-done");
        }
        // second acquisition's leaf: stays in flight until the test releases it
        await secondLeafGate;
        return ok("leaf-2-done");
      };

      const runtime = new OrchestrationChildRuntime(makeCore(runChild));
      const service = new WorkflowService({
        runtime,
        policyPath,
        taintTracker: tracker,
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

      const first = service.start(spec());
      // AC: no LEAF_SANDBOX_UNAVAILABLE refusal with a runtime that actually
      // installs the sandbox (the inverse of workflow-service-durability.test
      // .ts's "refuses to launch ... cannot install the leaf sandbox").
      expect("error" in first).toBe(false);
      if ("error" in first) throw new Error(first.error);
      runId1 = first.run_id;
      workingRoot1 = service.workingRootFor(runId1);
      await service.status(first.run_id, true);

      expect(stepResults).toEqual([
        { step: "inside-working-root", out: "allowed:write_file" },
        {
          step: "outside-every-root",
          out: "ERROR: path is outside the workflow working scope (sandbox denied)",
        },
        { step: "ro-root-read", out: "allowed:read_file" },
        {
          step: "ro-root-write",
          out: "ERROR: path is under a read-only workflow root (sandbox denied the write)",
        },
        {
          step: "egress-denied",
          out: "ERROR: host is not in the workflow egress allowlist (sandbox denied)",
        },
        { step: "taint-before", out: "false" },
        { step: "egress-allowed", out: "allowed:web_fetch" },
        { step: "taint-after", out: "true" },
        { step: "tainted-fs", out: "ERROR: tainted run: filesystem access is disabled for leaves" },
        {
          step: "tainted-egress",
          out: "ERROR: tainted run: web egress is disabled for leaves",
        },
      ]);
      // a denied call never reached the base leaf dispatch
      expect(leaf1BaseCalls).toEqual(["write_file", "read_file", "web_fetch"]);

      // second acquisition of the SAME run: fence advances, its leaf stays
      // in flight so it is the CURRENT stretch for the assertion below
      const second = service.start(null, {}, { resumeRunId: runId1 });
      if ("error" in second) throw new Error(second.error);

      // fence 1's wrapper, resolved back when the FIRST leaf spawned, is
      // still the exact function value the sandbox composed for that
      // acquisition — invoking it again now that fence 2 owns the run must
      // deny, and must never reach a new base dispatch.
      if (firstWrapDispatch === undefined) throw new Error("firstWrapDispatch missing");
      const retiredBaseCalls: string[] = [];
      const retiredBase: ChildToolDispatch = (name) => {
        retiredBaseCalls.push(name);
        return Promise.resolve(`should-not-happen:${name}`);
      };
      const retiredOut = await firstWrapDispatch(retiredBase)("write_file", {
        path: join(root, "runs", runId1, "work-1", "again.txt"),
      });
      expect(retiredOut).toBe("ERROR: workflow stretch is no longer current (sandbox denied)");
      expect(retiredBaseCalls).toEqual([]);

      openSecondLeaf();
      await service.status(runId1, true);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("OrchestrationChildRuntime — ephemeral launch: leaves deny-all until the store path installs (#101)", () => {
  it("a WorkflowService with no store (chat.ts/dashboard.ts's own wiring) never calls installLeafSandbox, so a leaf's tool call is denied fail-closed", async () => {
    // launch() (no store, service.ts) never installs a sandbox — only
    // launchDurable() does. This is a KNOWN, spec'd consequence of #107's
    // AC "spawn com causalContext.runId sem instalação viva não despacha
    // tool sem sandbox": before this issue, an ephemeral leaf's tool calls
    // ran through createChildDispatch(baseDispatch) unsandboxed; after,
    // every one is denied fail-closed until #101 wires a store (and thus
    // launchDurable) into production. Confirmed live via dogfooding
    // (run_workflow through chat.ts with no store): the leaf's read_file
    // call came back denied with exactly this message.
    let capturedWrapDispatch: WrapDispatch | undefined;
    const baseCalls: string[] = [];
    const runChild: ChildRunner = async (_subId, config) => {
      capturedWrapDispatch = config.wrapDispatch;
      const base: ChildToolDispatch = (name) => {
        baseCalls.push(name);
        return Promise.resolve(`allowed:${name}`);
      };
      const dispatch = config.wrapDispatch === undefined ? base : config.wrapDispatch(base);
      const out = await dispatch("read_file", { path: "/tmp/whatever" });
      return ok(out);
    };
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    // no `store` at all — exactly chat.ts:287/dashboard.ts:212's own shape
    const service = new WorkflowService({ runtime });

    const started = service.start(spec());
    if ("error" in started) throw new Error(started.error);
    const done = (await service.status(started.run_id, true)) as Record<string, unknown>;

    expect(done.status).toBe("complete");
    expect(done.outputs).toEqual({
      a: "ERROR: no leaf sandbox installed for this run — 'read_file' denied fail-closed",
    });
    // the deny short-circuited before the real leaf tool dispatch
    expect(baseCalls).toEqual([]);
    expect(capturedWrapDispatch).toBeDefined();
  });
});
