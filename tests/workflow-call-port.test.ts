// Issue #978 (épico #976 §6): `ChildRuntime.callTool` — a tool call WITHOUT a
// model, through the same sandbox/taint/fence a leaf's tool call goes
// through. The security claim is the point of this file: a call the sandbox
// (or the install, or the allow-list) turns away NEVER reaches the base
// dispatch, and a call it lets through reaches it exactly once.
//
// Three layers, cheapest first: the pure rules (`call-tools.ts`); the port on
// `OrchestrationChildRuntime` with a hand-made installation; and the same
// port through a REAL `WorkflowService` (its own `stretchToolDispatch`, its
// own `TaintTracker`, its own operator policy file).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OrchestrationCore,
  type ChildRunner,
  type CollectResult,
} from "../src/orchestration/core.js";
import { LockRepository, openStateDatabase, WorkflowRepository } from "../src/state/index.js";
import type { RegistryDispatch } from "../src/tools/types.js";
import {
  CALL_TOOLS,
  MAX_CALL_TIMEOUT_SECONDS,
  callDeadlineMs,
  callSubId,
  classifyCallOutput,
  isCallTool,
  isOkEnvelope,
} from "../src/workflow/call-tools.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import type {
  CallToolRequest,
  CausalContext,
  ChildRuntime,
  LeafSandboxInstallation,
  LeafToolDispatch,
} from "../src/workflow/runtime.js";
import { TaintTracker } from "../src/workflow/sandbox.js";
import { WorkflowService } from "../src/workflow/service.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

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
    errorKind: null,
    retryAfter: null,
  };
}

function makeCore(runChild: ChildRunner = () => Promise.resolve(ok("unused"))): OrchestrationCore {
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

function causal(runId: string, overrides: Partial<CausalContext> = {}): CausalContext {
  return Object.freeze({
    runId,
    segmentId: "seg-1",
    nodePath: Object.freeze(["fetch"]),
    cellId: "fetch:0",
    role: "call",
    attempt: 0,
    turn: 0,
    ...overrides,
  });
}

function request(
  runId: string,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
  timeoutSeconds = 5,
): CallToolRequest {
  return { name, args, timeoutSeconds, causalContext: causal(runId) };
}

/** A base dispatch that records every call it ACTUALLY receives. */
function spyBase(
  reply: (name: string) => Promise<string> | string = (name) => `{"ok":true,"tool":"${name}"}`,
): {
  readonly dispatch: RegistryDispatch;
  readonly calls: { readonly name: string; readonly args: Readonly<Record<string, unknown>> }[];
} {
  const calls: { name: string; args: Readonly<Record<string, unknown>> }[] = [];
  return {
    calls,
    dispatch: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(reply(name));
    },
  };
}

const passThrough = (base: LeafToolDispatch): LeafToolDispatch => base;

describe("call-tools — the allow-list and the verdict", () => {
  it("CALL_TOOLS is exactly read_file and web_fetch, and cannot be widened at runtime", () => {
    expect([...CALL_TOOLS]).toEqual(["read_file", "web_fetch"]);
    expect(Object.isFrozen(CALL_TOOLS)).toBe(true);
    for (const name of CALL_TOOLS) expect(isCallTool(name)).toBe(true);
    for (const name of [
      "write_file",
      "terminal",
      "web_search",
      "mcp_server_tool",
      "delegate_task",
      "run_workflow",
      "READ_FILE",
      " read_file",
      "",
    ]) {
      expect(isCallTool(name)).toBe(false);
    }
  });

  it("the deadline is the caller's own seconds, capped at 120 s, and never absent", () => {
    expect(MAX_CALL_TIMEOUT_SECONDS).toBe(120);
    expect(callDeadlineMs(5)).toBe(5_000);
    expect(callDeadlineMs(0.05)).toBe(50);
    expect(callDeadlineMs(120)).toBe(120_000);
    expect(callDeadlineMs(121)).toBe(120_000);
    expect(callDeadlineMs(86_400)).toBe(120_000);
    // a runtime never runs a call unbounded (invariant 3): nothing usable means the ceiling
    for (const unusable of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(callDeadlineMs(unusable)).toBe(120_000);
    }
  });

  it("the synthetic sub_id names the cell and the attempt, and differs between attempts", () => {
    expect(callSubId(causal("r", { cellId: "fetch:0", attempt: 0 }))).toBe("call:fetch:0:0");
    expect(callSubId(causal("r", { cellId: "fetch:0", attempt: 2 }))).toBe("call:fetch:0:2");
    expect(callSubId(causal("r", { cellId: "other", attempt: 2 }))).not.toBe(
      callSubId(causal("r", { cellId: "fetch:0", attempt: 2 })),
    );
  });

  it("an envelope is ok only when it says so — the tool's own error envelope is not", () => {
    expect(isOkEnvelope('{"ok":true,"data":"x"}')).toBe(true);
    expect(isOkEnvelope('{"ok":false,"error":"x"}')).toBe(false);
    expect(isOkEnvelope('{"error":"no such file"}')).toBe(false);
    expect(isOkEnvelope("ERROR: path is outside the workflow working scope (sandbox denied)")).toBe(
      false,
    );
    expect(isOkEnvelope("")).toBe(false);
  });

  it("a call that never reached the dispatch is denied; one that did is ok or error by its envelope — verbatim", () => {
    const denied = "ERROR: host is not in the workflow egress allowlist (sandbox denied)";
    expect(classifyCallOutput(false, denied)).toEqual({ status: "denied", output: denied });
    // even an output that LOOKS like an ok envelope is a denial when base was never reached
    expect(classifyCallOutput(false, '{"ok":true}').status).toBe("denied");
    const good = '{"ok":true,"data":{"content":"hi"}}';
    expect(classifyCallOutput(true, good)).toEqual({ status: "ok", output: good });
    const bad = '{"error":"file not found"}';
    expect(classifyCallOutput(true, bad)).toEqual({ status: "error", output: bad });
    // a reached tool that answers with sandbox-looking text is still the TOOL failing
    expect(classifyCallOutput(true, "ERROR: boom").status).toBe("error");
  });
});

describe("OrchestrationChildRuntime.callTool — refused before any dispatch", () => {
  it("a name outside CALL_TOOLS is denied before the installation's wrap or the base are touched", async () => {
    const base = spyBase();
    const runtime = new OrchestrationChildRuntime(makeCore(), base.dispatch);
    const wrapped: string[] = [];
    runtime.installLeafSandbox({
      runId: "r1",
      fence: 1,
      wrap: (inner) => (name, args) => {
        wrapped.push(name);
        return inner(name, args);
      },
    });
    for (const name of ["write_file", "terminal", "web_search", "mcp_x_y", "delegate_task", ""]) {
      const result = await runtime.callTool(request("r1", name, { path: "/x", command: "ls" }));
      expect(result.status).toBe("denied");
      expect(result.output).toMatch(/^ERROR: /);
      expect(result.output).toContain("read_file");
    }
    expect(wrapped).toEqual([]);
    expect(base.calls).toEqual([]);
  });

  it("without an installation for the run it is denied fail-closed and never dispatches", async () => {
    const base = spyBase();
    const runtime = new OrchestrationChildRuntime(makeCore(), base.dispatch);
    const result = await runtime.callTool(request("never-installed", "read_file", { path: "/x" }));
    expect(result.status).toBe("denied");
    expect(result.output).toBe(
      "ERROR: no leaf sandbox installed for this run — 'read_file' denied fail-closed",
    );
    expect(base.calls).toEqual([]);
  });

  it("after the installation's own dispose() it is denied again", async () => {
    const base = spyBase();
    const runtime = new OrchestrationChildRuntime(makeCore(), base.dispatch);
    const handle = runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: passThrough });
    expect((await runtime.callTool(request("r1", "read_file", { path: "/x" }))).status).toBe("ok");
    handle.dispose();
    const result = await runtime.callTool(request("r1", "read_file", { path: "/x" }));
    expect(result.status).toBe("denied");
    expect(base.calls).toHaveLength(1);
  });

  it("a runtime built without baseDispatch answers a named error instead of dispatching or throwing", async () => {
    const runtime = new OrchestrationChildRuntime(makeCore());
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: passThrough });
    const result = await runtime.callTool(request("r1", "read_file", { path: "/x" }));
    expect(result.status).toBe("error");
    expect(result.output).toMatch(/^ERROR: /);
    expect(result.output).toContain("baseDispatch");
  });
});

describe("OrchestrationChildRuntime.callTool — through the installation's wrap", () => {
  it("a call the wrap lets through reaches the base exactly once, with the caller's args, and the envelope comes back verbatim", async () => {
    const envelope = '{"ok":true,"data":{"content":"hello"}}';
    const base = spyBase(() => envelope);
    const runtime = new OrchestrationChildRuntime(makeCore(), base.dispatch);
    const seen: string[] = [];
    runtime.installLeafSandbox({
      runId: "r1",
      fence: 1,
      wrap: (inner) => (name, args) => {
        seen.push(`${name}:${String(args.path)}`);
        return inner(name, args);
      },
    });
    const args = { path: "/work/a.txt" };
    const result = await runtime.callTool(request("r1", "read_file", args));
    expect(result).toEqual({ status: "ok", output: envelope });
    expect(seen).toEqual(["read_file:/work/a.txt"]);
    expect(base.calls).toHaveLength(1);
    expect(base.calls[0]?.name).toBe("read_file");
    expect(base.calls[0]?.args).toEqual({ path: "/work/a.txt" });
    // the dispatched args are a frozen copy: the caller's object can no longer change what ran
    expect(Object.isFrozen(base.calls[0]?.args)).toBe(true);
    expect(base.calls[0]?.args).not.toBe(args);
  });

  it("a denial from the wrap is `denied`, keeps its text, and the base never sees the call", async () => {
    const base = spyBase();
    const runtime = new OrchestrationChildRuntime(makeCore(), base.dispatch);
    const denial = "ERROR: path is outside the workflow working scope (sandbox denied)";
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: () => () => denial });
    const result = await runtime.callTool(request("r1", "read_file", { path: "/etc/passwd" }));
    expect(result).toEqual({ status: "denied", output: denial });
    expect(base.calls).toEqual([]);
  });

  it("the newest installation of the run is the one consulted (an older fence cannot answer for it)", async () => {
    const base = spyBase();
    const runtime = new OrchestrationChildRuntime(makeCore(), base.dispatch);
    const tag: string[] = [];
    const tagged =
      (label: string) =>
      (inner: LeafToolDispatch): LeafToolDispatch =>
      (name, args) => {
        tag.push(label);
        return inner(name, args);
      };
    const older = runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: tagged("old") });
    runtime.installLeafSandbox({ runId: "r1", fence: 2, wrap: tagged("new") });
    older.dispose();
    await runtime.callTool(request("r1", "read_file", { path: "/x" }));
    expect(tag).toEqual(["new"]);
  });

  it("a tool that answers with its own error envelope is `error`, not `denied`, and keeps the envelope", async () => {
    const envelope = '{"error":"no such file"}';
    const base = spyBase(() => envelope);
    const runtime = new OrchestrationChildRuntime(makeCore(), base.dispatch);
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: passThrough });
    const result = await runtime.callTool(request("r1", "read_file", { path: "/missing" }));
    expect(result).toEqual({ status: "error", output: envelope });
    expect(base.calls).toHaveLength(1);
  });

  it("a dispatch that throws is an `error` naming the cause — the port never throws", async () => {
    const runtime = new OrchestrationChildRuntime(makeCore(), () =>
      Promise.reject(new Error("socket hang up")),
    );
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: passThrough });
    const result = await runtime.callTool(request("r1", "web_fetch", { url: "https://x.test/" }));
    expect(result.status).toBe("error");
    expect(result.output).toMatch(/^ERROR: /);
    expect(result.output).toContain("socket hang up");
  });

  it("a denial leaves nothing behind per call (the synthetic sub_id never accumulates a refusal counter)", async () => {
    const base = spyBase();
    const runtime = new OrchestrationChildRuntime(makeCore(), base.dispatch);
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: () => () => "ERROR: no" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await runtime.callTool({
        ...request("r1", "read_file", { path: "/x" }),
        causalContext: causal("r1", { attempt }),
      });
    }
    const counters = (runtime as unknown as { refusalCounts: ReadonlyMap<string, unknown> })
      .refusalCounts;
    expect(counters.size).toBe(0);
  });
});

describe("OrchestrationChildRuntime.callTool — the deadline", () => {
  it("a dispatch that never settles comes back `timeout` within the deadline, without throwing", async () => {
    const runtime = new OrchestrationChildRuntime(
      makeCore(),
      () => new Promise<string>(() => undefined),
    );
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: passThrough });
    const startedAt = performance.now();
    const result = await runtime.callTool(
      request("r1", "web_fetch", { url: "https://x.test/" }, 0.05),
    );
    expect(result.status).toBe("timeout");
    expect(result.output).toMatch(/^ERROR: /);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("the deadline timer is cleared on a timeout and on a call that settles first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settleLate: (() => void) | undefined;
    const runtime = new OrchestrationChildRuntime(makeCore(), (name) =>
      name === "web_fetch"
        ? new Promise<string>((resolve) => {
            settleLate = () => {
              resolve('{"ok":true}');
            };
          })
        : Promise.resolve('{"ok":true}'),
    );
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: passThrough });

    const quick = await runtime.callTool(request("r1", "read_file", { path: "/x" }, 5));
    expect(quick.status).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);

    const slow = runtime.callTool(request("r1", "web_fetch", { url: "https://x.test/" }, 5));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await slow).status).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
    settleLate?.();
  });

  it("a timeoutSeconds past the ceiling still ends at 120 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runtime = new OrchestrationChildRuntime(
      makeCore(),
      () => new Promise<string>(() => undefined),
    );
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: passThrough });
    let settled = false;
    const pending = runtime
      .callTool(request("r1", "web_fetch", { url: "https://x.test/" }, 3_600))
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a dispatch that fails AFTER the deadline does not surface as an unhandled rejection or change the verdict", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let failLate: (() => void) | undefined;
    const runtime = new OrchestrationChildRuntime(
      makeCore(),
      () =>
        new Promise<string>((_resolve, reject) => {
          failLate = () => {
            reject(new Error("late failure"));
          };
        }),
    );
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: passThrough });
    const pending = runtime.callTool(request("r1", "web_fetch", { url: "https://x.test/" }, 1));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.status).toBe("timeout");
    failLate?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.status).toBe("timeout");
  });
});

function policyFile(root: string, body: Record<string, unknown>): string {
  const path = join(root, "workflow_policy.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

function spec(): Record<string, unknown> {
  return { meta: { name: "call-port" }, nodes: [{ id: "a", type: "agent", prompt: "do it" }] };
}

/** Opens a store-backed `WorkflowService` over a real runtime — the only
 * composition in which `installLeafSandbox` is called, so the only one in
 * which `stretchToolDispatch` (service.ts) judges a `callTool`. */
function durable(
  runChild: ChildRunner,
  base: RegistryDispatch,
  options: { readonly leakInstallation?: boolean } = {},
): {
  readonly service: WorkflowService;
  readonly runtime: OrchestrationChildRuntime;
  readonly tracker: TaintTracker;
  readonly readOnlyRoot: string;
  readonly close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-call-port-"));
  roots.push(root);
  const readOnlyRoot = join(root, "reference");
  mkdirSync(readOnlyRoot, { recursive: true });
  const policyPath = policyFile(root, {
    fs_allow: [{ path: readOnlyRoot, mode: "ro" }],
    egress_allow: ["docs.example.com"],
  });
  const connection = openStateDatabase(join(root, "state.db"));
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const tracker = new TaintTracker();
  const runtime = new OrchestrationChildRuntime(makeCore(runChild), base);
  // `leakInstallation` models a disposal that lags or fails: the runtime keeps the
  // installation, but the service has already retired the stretch it was pinned to.
  const served: ChildRuntime =
    options.leakInstallation === true
      ? {
          spawn: (spawnRequest) => runtime.spawn(spawnRequest),
          collect: (id, collectOptions) => runtime.collect(id, collectOptions),
          steer: (id, prompt, causalContext) => {
            runtime.steer(id, prompt, causalContext);
          },
          cancel: (id) => runtime.cancel(id),
          installLeafSandbox: (installation: LeafSandboxInstallation) => {
            runtime.installLeafSandbox(installation);
            return { dispose: () => undefined };
          },
        }
      : runtime;
  const service = new WorkflowService({
    runtime: served,
    policyPath,
    taintTracker: tracker,
    homeRoot: root,
    timerFactory: () => ({ cancel: () => undefined }),
    store: {
      repository: new WorkflowRepository(connection.database),
      locks: new LockRepository(connection.database),
      holder: "test",
      ttl: 900,
      ownershipOf: () => ownership,
      database: connection.database,
    },
  });
  return {
    service,
    runtime,
    tracker,
    readOnlyRoot,
    close: () => {
      connection.close();
    },
  };
}

describe("OrchestrationChildRuntime.callTool — the real service's sandbox, taint and stretch", () => {
  it("a live stretch: working root and ro root pass, everything else is denied, a web_fetch taints, and a tainted run closes both doors — the base sees only the calls that were allowed", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runChild: ChildRunner = async () => {
      enter();
      await gate;
      return ok("done");
    };
    const base = spyBase();
    const { service, runtime, tracker, readOnlyRoot, close } = durable(runChild, base.dispatch);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      const runId = started.run_id;
      await entered;
      const workingRoot = service.workingRootFor(runId);
      const call = (name: string, args: Record<string, unknown>) =>
        runtime.callTool(request(runId, name, args));

      // inside the leaf's working root, and in the operator's read-only root
      const inWork = await call("read_file", { path: join(workingRoot, "note.txt") });
      expect(inWork.status).toBe("ok");
      const inRef = await call("read_file", { path: join(readOnlyRoot, "a.txt") });
      expect(inRef.status).toBe("ok");
      expect(base.calls.map((c) => c.name)).toEqual(["read_file", "read_file"]);

      // outside every root, a traversal, and a host that is not allow-listed
      const outside = await call("read_file", { path: join(readOnlyRoot, "..", "elsewhere.txt") });
      expect(outside.status).toBe("denied");
      expect(outside.output).toMatch(/^ERROR: /);
      const evil = await call("web_fetch", { url: "https://evil.example.com/x" });
      expect(evil).toEqual({
        status: "denied",
        output: "ERROR: host is not in the workflow egress allowlist (sandbox denied)",
      });
      // a name the allow-list never lets in is refused before the sandbox is asked
      const write = await call("write_file", { path: join(workingRoot, "x.txt") });
      expect(write.status).toBe("denied");
      expect(base.calls).toHaveLength(2);
      expect(tracker.tainted).toBe(false);

      // an allowed host: reaches the base once, and taints the run (same as a leaf)
      const fetched = await call("web_fetch", { url: "https://DOCS.example.com/x" });
      expect(fetched.status).toBe("ok");
      expect(base.calls).toHaveLength(3);
      expect(tracker.tainted).toBe(true);

      // tainted: filesystem and egress are both closed, and the base is not reached again
      const taintedRead = await call("read_file", { path: join(readOnlyRoot, "a.txt") });
      expect(taintedRead).toEqual({
        status: "denied",
        output: "ERROR: tainted run: filesystem access is disabled for leaves",
      });
      const taintedFetch = await call("web_fetch", { url: "https://docs.example.com/x" });
      expect(taintedFetch).toEqual({
        status: "denied",
        output: "ERROR: tainted run: web egress is disabled for leaves",
      });
      expect(base.calls).toHaveLength(3);

      release();
      await service.status(runId, true);
    } finally {
      release();
      close();
    }
  });

  it("a call made with the run's installation gone (the stretch finished and disposed) is denied and never dispatches", async () => {
    const base = spyBase();
    const { service, runtime, readOnlyRoot, close } = durable(
      () => Promise.resolve(ok("done")),
      base.dispatch,
    );
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const result = await runtime.callTool(
        request(started.run_id, "read_file", { path: join(readOnlyRoot, "a.txt") }),
      );
      expect(result.status).toBe("denied");
      expect(result.output).toContain("no leaf sandbox installed");
      expect(base.calls).toEqual([]);
    } finally {
      close();
    }
  });

  it("a RETIRED stretch whose installation is still held is denied with 'no longer current' and never dispatches", async () => {
    const base = spyBase();
    const { service, runtime, readOnlyRoot, close } = durable(
      () => Promise.resolve(ok("done")),
      base.dispatch,
      { leakInstallation: true },
    );
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const workingRoot = service.workingRootFor(started.run_id);
      for (const path of [join(workingRoot, "note.txt"), join(readOnlyRoot, "a.txt")]) {
        const result = await runtime.callTool(request(started.run_id, "read_file", { path }));
        expect(result).toEqual({
          status: "denied",
          output: "ERROR: workflow stretch is no longer current (sandbox denied)",
        });
      }
      const fetched = await runtime.callTool(
        request(started.run_id, "web_fetch", { url: "https://docs.example.com/x" }),
      );
      expect(fetched.status).toBe("denied");
      expect(fetched.output).toContain("no longer current");
      expect(base.calls).toEqual([]);
    } finally {
      close();
    }
  });
});
