// Issue #978 (épico #976 §6): `AuditedChildRuntime.callTool` — a model-free
// tool call leaves exactly ONE `tool.started`/`tool.completed` pair in the
// ledger, keyed by the calling node (`node_id`, `attempt`, `segment_id`) and a
// SYNTHETIC `sub_id` (`call:<cell>:<attempt>`), and NO `leaf.*` event: there is
// no leaf. Driven through the real chain a production run uses —
// `auditedChildRuntime(OrchestrationChildRuntime)` with its wrapped
// `installLeafSandbox` — over a real sqlite-backed `AuditRepository`, so the
// pair cannot be doubled by the leaf path nor lost by the sanitizer.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OrchestrationCore,
  type ChildRunner,
  type CollectResult,
} from "../src/orchestration/core.js";
import { AuditRepository, openStateDatabase } from "../src/state/index.js";
import type { RegistryDispatch } from "../src/tools/types.js";
import { auditedChildRuntime, type AuditedChildRuntime } from "../src/workflow/audit-runtime.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import type {
  CallToolRequest,
  CallToolResult,
  CausalContext,
  ChildRuntime,
  LeafToolDispatch,
} from "../src/workflow/runtime.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const RUN = "run-call-audit";

function done(output: string): CollectResult {
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

function makeCore(
  runChild: ChildRunner = () => Promise.resolve(done("unused")),
): OrchestrationCore {
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

function causal(overrides: Partial<CausalContext> = {}): CausalContext {
  return Object.freeze({
    runId: RUN,
    segmentId: "seg-call",
    nodePath: Object.freeze(["outer", "fetch"]),
    cellId: "fetch:0",
    role: "call",
    attempt: 1,
    turn: 0,
    ...overrides,
  });
}

function request(
  name: string,
  args: Readonly<Record<string, unknown>> = { path: "/work/a.txt" },
  timeoutSeconds = 5,
): CallToolRequest {
  return { name, args, timeoutSeconds, causalContext: causal() };
}

const passThrough = (base: LeafToolDispatch): LeafToolDispatch => base;

interface Rig {
  readonly runtime: AuditedChildRuntime;
  readonly baseCalls: string[];
  readonly warnings: string[];
  readonly events: () => Promise<
    readonly {
      readonly type: string;
      readonly node_id: unknown;
      readonly sub_id: unknown;
      readonly attempt: unknown;
      readonly segment_id: unknown;
      readonly data: Readonly<Record<string, unknown>>;
    }[]
  >;
  readonly close: () => void;
}

function rig(
  options: {
    readonly wrap?: (base: LeafToolDispatch) => LeafToolDispatch;
    readonly reply?: () => Promise<string>;
    readonly runChild?: ChildRunner;
    readonly durable?: boolean;
    readonly noInstall?: boolean;
  } = {},
): Rig {
  const root = mkdtempSync(join(tmpdir(), "lohra-call-audit-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const baseCalls: string[] = [];
  const warnings: string[] = [];
  const base: RegistryDispatch = (name) => {
    baseCalls.push(name);
    return options.reply === undefined ? Promise.resolve('{"ok":true}') : options.reply();
  };
  const inner = new OrchestrationChildRuntime(makeCore(options.runChild), base);
  const runtime = auditedChildRuntime(inner, {
    trail,
    ownershipOf: () => null,
    durable: options.durable ?? false,
    warn: (message) => {
      warnings.push(message);
    },
  });
  if (options.noInstall !== true) {
    runtime.installLeafSandbox?.({ runId: RUN, fence: 1, wrap: options.wrap ?? passThrough });
  }
  return {
    runtime,
    baseCalls,
    warnings,
    events: async () => {
      await trail.flush();
      return audit.query({ runId: RUN, limit: 100 }).events.map((event) => ({
        type: event.event_type,
        node_id: event.identity.node_id,
        sub_id: event.identity.sub_id,
        attempt: event.identity.attempt,
        segment_id: event.identity.segment_id,
        data: event.data,
      }));
    },
    close: () => {
      connection.close();
    },
  };
}

function callOf(runtime: AuditedChildRuntime): (r: CallToolRequest) => Promise<CallToolResult> {
  if (runtime.callTool === undefined) throw new Error("callTool missing on the audited runtime");
  return async (given) => {
    const result = await runtime.callTool?.(given);
    if (result === undefined) throw new Error("callTool missing on the audited runtime");
    return result;
  };
}

describe("AuditedChildRuntime.callTool — the tool.* pair", () => {
  it("a permitted call writes tool.started then tool.completed{success}, keyed by node, attempt, segment and a synthetic sub_id — and no leaf.*", async () => {
    const t = rig();
    try {
      const result = await callOf(t.runtime)(
        request("read_file", { path: "/work/a.txt", mode: "x" }),
      );
      expect(result.status).toBe("ok");
      const events = await t.events();
      expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
      for (const event of events) {
        expect(event.node_id).toBe("fetch");
        expect(event.sub_id).toBe("call:fetch:0:1");
        expect(event.attempt).toBe(1);
        expect(event.segment_id).toBe("seg-call");
      }
      expect(events[0]?.data).toEqual({ tool_name_state: "known_tool", fields: 2 });
      expect(events[1]?.data).toEqual({ status: "success" });
      expect(events.some((event) => event.type.startsWith("leaf."))).toBe(false);
      expect(t.baseCalls).toEqual(["read_file"]);
      expect(t.warnings).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("a sandbox denial closes the pair as error/sandbox_denied and the base is never reached", async () => {
    const t = rig({
      wrap: () => () => "ERROR: path is outside the workflow working scope (sandbox denied)",
    });
    try {
      const result = await callOf(t.runtime)(request("read_file", { path: "/etc/passwd" }));
      expect(result.status).toBe("denied");
      const events = await t.events();
      expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
      expect(events[1]?.data).toEqual({ status: "error", reason: "sandbox_denied" });
      expect(t.baseCalls).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("a name outside CALL_TOOLS is still ledgered (started, then error/sandbox_denied) and never dispatches", async () => {
    const t = rig();
    try {
      const result = await callOf(t.runtime)(request("terminal", { command: "rm -rf /" }));
      expect(result.status).toBe("denied");
      const events = await t.events();
      expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
      expect(events[1]?.data).toEqual({ status: "error", reason: "sandbox_denied" });
      expect(t.baseCalls).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("with no installation at all the call is denied and the pair is still closed", async () => {
    const t = rig({ noInstall: true });
    try {
      const result = await callOf(t.runtime)(request("read_file"));
      expect(result.status).toBe("denied");
      const events = await t.events();
      expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
      expect(events[1]?.data).toEqual({ status: "error", reason: "sandbox_denied" });
      expect(t.baseCalls).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("a tool that fails closes the pair as a plain error — no reason, distinct from a denial", async () => {
    const t = rig({ reply: () => Promise.resolve('{"error":"no such file"}') });
    try {
      const result = await callOf(t.runtime)(request("read_file"));
      expect(result.status).toBe("error");
      const events = await t.events();
      expect(events[1]?.data).toEqual({ status: "error" });
    } finally {
      t.close();
    }
  });

  it("a timeout closes the pair as error/cancelled, exactly once, even if the dispatch settles later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settleLate: (() => void) | undefined;
    const t = rig({
      reply: () =>
        new Promise<string>((resolve) => {
          settleLate = () => {
            resolve('{"ok":true}');
          };
        }),
    });
    try {
      const pending = callOf(t.runtime)(request("web_fetch", { url: "https://x.test/" }, 2));
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;
      expect(result.status).toBe("timeout");
      settleLate?.();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      const events = await t.events();
      expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
      expect(events[1]?.data).toEqual({ status: "error", reason: "cancelled" });
    } finally {
      t.close();
    }
  });

  it("two attempts of the same node write two distinct pairs, told apart by sub_id and attempt", async () => {
    const t = rig();
    try {
      const call = callOf(t.runtime);
      await call(request("read_file"));
      await call({ ...request("read_file"), causalContext: causal({ attempt: 2 }) });
      const events = await t.events();
      expect(events.map((event) => event.type)).toEqual([
        "tool.started",
        "tool.completed",
        "tool.started",
        "tool.completed",
      ]);
      expect(events.map((event) => event.sub_id)).toEqual([
        "call:fetch:0:1",
        "call:fetch:0:1",
        "call:fetch:0:2",
        "call:fetch:0:2",
      ]);
      expect(events.map((event) => event.attempt)).toEqual([1, 1, 2, 2]);
    } finally {
      t.close();
    }
  });

  it("sanitization: an argument value and the tool name never reach the payload", async () => {
    const t = rig();
    try {
      await callOf(t.runtime)(request("read_file", { path: "/work/segredo-ação-CANARY-9f3.txt" }));
      const serialized = JSON.stringify(await t.events());
      expect(serialized).not.toContain("CANARY");
      expect(serialized).not.toContain("segredo");
    } finally {
      t.close();
    }
  });

  it("it does not disturb a leaf in flight: the leaf keeps its own pair and nothing is flushed as cancelled on its close", async () => {
    const t = rig();
    try {
      const id = await t.runtime.spawn({
        prompt: "go",
        causalContext: causal({ role: "agent", nodePath: ["leaf-node"], cellId: "leaf-node:0" }),
      });
      await callOf(t.runtime)(request("read_file"));
      const collected = await t.runtime.collect(id, { wait: true, timeoutSeconds: 5 });
      expect(collected.status).toBe("complete");
      const events = await t.events();
      expect(events.map((event) => event.type)).toEqual([
        "leaf.started",
        "tool.started",
        "tool.completed",
        "leaf.completed",
      ]);
      expect(events[1]?.sub_id).toBe("call:fetch:0:1");
      expect(events[2]?.data).toEqual({ status: "success" });
    } finally {
      t.close();
    }
  });

  it("fail-closed: a durable stretch that lost ownership writes nothing and names the drop", async () => {
    const t = rig({ durable: true });
    try {
      const result = await callOf(t.runtime)(request("read_file"));
      // the call itself is not blocked by the ledger: the verdict stands
      expect(result.status).toBe("ok");
      expect(await t.events()).toEqual([]);
      expect(
        t.warnings.some((w) => w.includes("ownership lost") && w.includes("tool.started")),
      ).toBe(true);
      expect(t.warnings.some((w) => w.includes("tool.completed"))).toBe(true);
    } finally {
      t.close();
    }
  });
});

describe("AuditedChildRuntime.callTool — presence follows the inner runtime", () => {
  it("is absent when inner has none (no permission is invented)", () => {
    const inner: ChildRuntime = {
      spawn: () => "x",
      collect: () => ({ status: "complete", output: null }),
      steer: () => undefined,
      cancel: () => undefined,
    };
    const audited = auditedChildRuntime(inner, {
      trail: undefined,
      ownershipOf: () => null,
      durable: false,
      warn: () => undefined,
    });
    expect("callTool" in audited).toBe(false);
  });

  it("forwards the request unchanged to inner and returns its verdict", async () => {
    const seen: CallToolRequest[] = [];
    const inner: ChildRuntime = {
      spawn: () => "x",
      collect: () => ({ status: "complete", output: null }),
      steer: () => undefined,
      cancel: () => undefined,
      callTool: (given) => {
        seen.push(given);
        return { status: "ok", output: '{"ok":true}' };
      },
    };
    const audited = auditedChildRuntime(inner, {
      trail: undefined,
      ownershipOf: () => null,
      durable: false,
      warn: () => undefined,
    });
    const asked = request("read_file");
    expect(await callOf(audited)(asked)).toEqual({ status: "ok", output: '{"ok":true}' });
    expect(seen).toEqual([asked]);
  });

  it("an inner that throws still closes the pair (error) and the failure propagates — never swallowed", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-call-audit-throw-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const inner: ChildRuntime = {
        spawn: () => "x",
        collect: () => ({ status: "complete", output: null }),
        steer: () => undefined,
        cancel: () => undefined,
        callTool: () => Promise.reject(new Error("port bug")),
      };
      const audited = auditedChildRuntime(inner, {
        trail,
        ownershipOf: () => null,
        durable: false,
        warn: () => undefined,
      });
      await expect(callOf(audited)(request("read_file"))).rejects.toThrow("port bug");
      await trail.flush();
      const types = audit
        .query({ runId: RUN, limit: 10 })
        .events.map((event) => [event.event_type, event.data.status]);
      expect(types).toEqual([
        ["tool.started", undefined],
        ["tool.completed", "error"],
      ]);
    } finally {
      connection.close();
    }
  });
});
