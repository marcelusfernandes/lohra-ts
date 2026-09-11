// Issue #369: `WorkflowLiveTail` — a per-process ring buffer bounded by BOTH
// event count (LIVE_TAIL_EVENTS) and serialized bytes (LIVE_TAIL_BYTES), the
// in-process `workflow_status.live_tail` consumer (`WorkflowTool`), and the
// `chat.ts`/`dashboard.ts` wiring that feeds it via `onLiveEvent`. The unit
// tests below exercise the ring directly (AC 1-4, 9). The two composition
// tests drive the real production entry points (`runChat`/`runDashboard`) —
// molded on `tests/workflow-durable-chat.test.ts` and
// `tests/workflow-durable-dashboard.test.ts` — because Files omits
// `src/commands/session-tools.ts` (the sole `workflowToolHandlers` call
// site): the tail reaches `workflow_status` via a SECOND, narrower
// `registry.overrideHandlers({ workflow_status })` call made directly in
// `chat.ts`/`dashboard.ts` after `composeSessionTools` returns, so only a
// real turn through those two files proves the wiring (AC 6).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { runChat } from "../src/commands/chat.js";
import { runDashboard, type DashboardCommandOptions } from "../src/commands/dashboard.js";
import { registerProvider } from "../src/providers/registry.js";
import { openStateDatabase } from "../src/state/connection.js";
import { LIVE_TAIL_BYTES, LIVE_TAIL_EVENTS, WorkflowLiveTail } from "../src/workflow/live-tail.js";
import type { WorkflowLiveEvent } from "../src/workflow/live-events.js";
import { productionOwnershipStore } from "../src/workflow/ownership-store.js";
import type { ChildRuntime } from "../src/workflow/runtime.js";
import { WorkflowService } from "../src/workflow/service.js";
import { WorkflowTool } from "../src/workflow/tool.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpDb(): ReturnType<typeof openStateDatabase> {
  const root = mkdtempSync(join(tmpdir(), "lohra-t369-live-tail-"));
  roots.push(root);
  return openStateDatabase(join(root, "state.db"));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

function event(
  runId: string,
  kind: WorkflowLiveEvent["kind"],
  extra: Readonly<Record<string, unknown>> = {},
): WorkflowLiveEvent {
  return Object.freeze({ kind, run_id: runId, ...extra });
}

function fakeRuntime(): ChildRuntime {
  return {
    spawn: () => "leaf",
    collect: () => ({ status: "complete", output: "ok", usage: null }),
    steer: () => undefined,
    cancel: () => undefined,
    // A durable-store WorkflowService refuses a launch fail-closed without
    // this (`service.ts`'s `leafSandboxUnavailable`) — the tests below that
    // wire `store` need it, and it is a harmless no-op for the ones that
    // don't.
    installLeafSandbox: () => ({ dispose: () => undefined }),
  };
}

describe("WorkflowLiveTail ring (issue #369)", () => {
  it("is empty before any push", () => {
    const tail = new WorkflowLiveTail();
    expect(tail.snapshot("nope")).toEqual({ events: [], next: 0, dropped: 0 });
  });

  it("keeps at most LIVE_TAIL_EVENTS and reports dropped once the cap is crossed; another run is unaffected", () => {
    const tail = new WorkflowLiveTail();
    for (let i = 0; i < 300; i += 1)
      tail.push(event("run-a", "node", { node_id: `n${String(i)}` }));
    const snap = tail.snapshot("run-a");
    expect(snap.events).toHaveLength(LIVE_TAIL_EVENTS);
    expect(snap.dropped).toBe(300 - LIVE_TAIL_EVENTS);

    tail.push(event("run-b", "node", { node_id: "only" }));
    const other = tail.snapshot("run-b");
    expect(other.dropped).toBe(0);
    expect(other.events).toHaveLength(1);
  });

  // Issue #383, item 1 (veredito da PR #382): the mutant `R2-drop-newest`
  // (`ring.events.shift()` → `pop()`) SURVIVED the first real corridor —
  // nothing above pins that the ring evicts the OLDEST event first (FIFO),
  // only that it evicts SOMETHING and stops growing past the cap. `pop()`
  // instead evicts the newest entry already in the ring each time, so the
  // final snapshot after `LIVE_TAIL_EVENTS + k` pushes would keep the
  // WRONG k events (a mix of the earliest ones plus the very last push) —
  // the first survivor's `node_id` is the one assertion `pop()` cannot
  // satisfy: FIFO's first survivor is always exactly the k-th pushed event.
  it("evicts the OLDEST event first (FIFO) — the first surviving event is exactly the k-th pushed", () => {
    const tail = new WorkflowLiveTail();
    const k = 7;
    for (let i = 0; i < LIVE_TAIL_EVENTS + k; i += 1)
      tail.push(event("run-fifo", "node", { node_id: `n${String(i)}` }));
    const snap = tail.snapshot("run-fifo");
    expect(snap.events).toHaveLength(LIVE_TAIL_EVENTS);
    expect(snap.dropped).toBe(k);
    expect(snap.events[0]?.node_id).toBe(`n${String(k)}`);
    expect(snap.events.at(-1)?.node_id).toBe(`n${String(LIVE_TAIL_EVENTS + k - 1)}`);
  });

  it("evicts by serialized bytes before the event count ever reaches the cap", () => {
    const tail = new WorkflowLiveTail();
    const bigNodes = Array.from({ length: 200 }, (_ignored, i) => `node-${String(i)}`);
    for (let i = 0; i < 40; i += 1)
      tail.push(event("run-plan", "plan", { nodes: bigNodes, name: `p${String(i)}` }));
    const snap = tail.snapshot("run-plan");
    expect(snap.events.length).toBeLessThan(LIVE_TAIL_EVENTS);
    const bytes = snap.events.reduce(
      (total, one) => total + Buffer.byteLength(JSON.stringify(one), "utf8"),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(LIVE_TAIL_BYTES);
    expect(snap.dropped).toBeGreaterThan(0);
  });

  it("snapshot(runId, afterIndex) returns only events after the cursor, with no duplicate and no gap across drops", () => {
    const tail = new WorkflowLiveTail();
    for (let i = 0; i < 5; i += 1) tail.push(event("run-c", "node", { node_id: `n${String(i)}` }));
    const first = tail.snapshot("run-c");
    expect(first.events).toHaveLength(5);
    expect(tail.snapshot("run-c", first.next).events).toHaveLength(0);

    for (let i = 5; i < 260; i += 1)
      tail.push(event("run-c", "node", { node_id: `n${String(i)}` }));
    const afterDrops = tail.snapshot("run-c", first.next);
    expect(afterDrops.events.length).toBeGreaterThan(0);
    const nodeIds = afterDrops.events.map((one) => one.node_id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(Number(String(nodeIds[0]).slice(1))).toBeGreaterThanOrEqual(5);
  });

  it("never throws on a payload it cannot serialize; warns and returns false instead", () => {
    const warnings: string[] = [];
    const tail = new WorkflowLiveTail((message) => warnings.push(message));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const bad = event("run-cyclic", "fault", { fault: "x", budget: cyclic });
    expect(() => tail.push(bad)).not.toThrow();
    expect(tail.push(bad)).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(tail.snapshot("run-cyclic")).toEqual({ events: [], next: 0, dropped: 0 });
  });

  it("a single event bigger than the whole byte cap is dropped, never stored, push still succeeds", () => {
    const tail = new WorkflowLiveTail();
    const huge = Array.from({ length: 20_000 }, (_ignored, i) => `n${String(i)}`);
    expect(tail.push(event("run-huge", "plan", { name: "huge", nodes: huge }))).toBe(true);
    const snap = tail.snapshot("run-huge");
    expect(snap.events).toHaveLength(0);
    expect(snap.dropped).toBe(1);
  });

  // PR #381 round 2, minor (a): an oversized single event must not sweep
  // the ring trying (and failing) to make room for itself.
  it("an oversized event drops only itself — small events already in the ring survive it", () => {
    const tail = new WorkflowLiveTail();
    tail.push(event("run-mixed", "node", { node_id: "a" }));
    tail.push(event("run-mixed", "node", { node_id: "b" }));
    const huge = Array.from({ length: 20_000 }, (_ignored, i) => `n${String(i)}`);
    expect(tail.push(event("run-mixed", "plan", { name: "huge", nodes: huge }))).toBe(true);
    const snap = tail.snapshot("run-mixed");
    expect(snap.events.map((one) => one.node_id)).toEqual(["a", "b"]);
    expect(snap.dropped).toBe(1);
  });

  // PR #381 round 2 finding: `done` fires on ANY stretch end, including
  // `paused` (a quota pause auto-resumes in the SAME process) — so
  // `forget()` clearing the counters too silently truncated a caller's
  // `next_cursor` history. `done` no longer occupies a cursor slot itself
  // (it is a forget signal, not tail content), and `next`/`dropped` must
  // never regress while the run stays known.
  it("forgets a run's ring on its own `done` event, but next/dropped never reset — same discipline as WorkflowLiveEvents for the ring, not the counters", () => {
    const tail = new WorkflowLiveTail();
    tail.push(event("run-done", "plan", { name: "x", nodes: ["a"] }));
    tail.push(event("run-done", "node", { node_id: "a", state: "running" }));
    const before = tail.snapshot("run-done");
    expect(before.events.length).toBeGreaterThan(0);
    expect(before.next).toBe(2);
    tail.push(event("run-done", "done", { state: "complete" }));
    const after = tail.snapshot("run-done");
    expect(after.events).toHaveLength(0);
    expect(after.next).toBe(2);
    expect(after.dropped).toBe(0);
  });

  it("forget(runId) clears a ring directly, but leaves next/dropped intact", () => {
    const tail = new WorkflowLiveTail();
    tail.push(event("run-forget", "node", { node_id: "a" }));
    tail.forget("run-forget");
    const snap = tail.snapshot("run-forget");
    expect(snap.events).toHaveLength(0);
    expect(snap.next).toBe(1);
    expect(snap.dropped).toBe(0);
  });

  // The exact reproduction from PR #381 round 2's blocking finding: a
  // same-process pause→auto-resume must never make a caller's
  // `next_cursor` regress or silently lose the events pushed after it.
  it("a same-process pause and resume never regresses next_cursor or silently drops the events after it", () => {
    const tail = new WorkflowLiveTail();
    tail.push(event("run-resume", "plan", { name: "x", nodes: ["a"] }));
    tail.push(event("run-resume", "node", { node_id: "a", state: "running" }));
    const beforePause = tail.snapshot("run-resume");
    expect(beforePause.next).toBe(2);
    tail.push(event("run-resume", "done", { state: "paused" }));
    tail.push(event("run-resume", "plan", { name: "x", nodes: ["a"] }));
    tail.push(event("run-resume", "node", { node_id: "a", state: "running" }));
    const afterResume = tail.snapshot("run-resume", beforePause.next);
    expect(afterResume.events).toHaveLength(2);
    expect(afterResume.next).toBe(4);
    expect(afterResume.dropped).toBe(0);
  });

  it("done{complete} after a full run does not regress next_cursor either", () => {
    const tail = new WorkflowLiveTail();
    tail.push(event("run-complete", "plan", { name: "x", nodes: ["a"] }));
    tail.push(event("run-complete", "node", { node_id: "a", state: "running" }));
    tail.push(event("run-complete", "node", { node_id: "a", state: "complete" }));
    tail.push(event("run-complete", "done", { state: "complete" }));
    const snap = tail.snapshot("run-complete");
    expect(snap.events).toHaveLength(0);
    expect(snap.next).toBe(3);
    expect(snap.dropped).toBe(0);
  });

  it("isKnown stays true after `done` forgets the ring — a run this tail ran is known for the rest of the process", () => {
    const tail = new WorkflowLiveTail();
    expect(tail.isKnown("run-known")).toBe(false);
    tail.push(event("run-known", "plan", { name: "x", nodes: ["a"] }));
    expect(tail.isKnown("run-known")).toBe(true);
    tail.push(event("run-known", "done", { state: "complete" }));
    expect(tail.snapshot("run-known").events).toHaveLength(0);
    expect(tail.isKnown("run-known")).toBe(true);
    expect(tail.isKnown("run-elsewhere")).toBe(false);
  });

  // PR #381 round 2, minor (c): a run whose only event so far failed to
  // serialize is not "known" — `push` already warned and returned `false`,
  // so the failure is loud; a later successful push still registers it.
  it("isKnown stays false until the first successful serialize for that run", () => {
    const tail = new WorkflowLiveTail();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(tail.push(event("run-late", "fault", { fault: "x", budget: cyclic }))).toBe(false);
    expect(tail.isKnown("run-late")).toBe(false);
    expect(tail.push(event("run-late", "node", { node_id: "a" }))).toBe(true);
    expect(tail.isKnown("run-late")).toBe(true);
  });

  // PR #381 round 2, minor (b): a long-lived process launching more than
  // KNOWN_RUNS_CAP distinct runs must not grow `runs` forever — the oldest
  // run whose ring is already empty (its `done` already forgot it) is
  // evicted first.
  it("caps the number of distinct known runs, evicting the oldest already-done one first", () => {
    const tail = new WorkflowLiveTail();
    tail.push(event("run-oldest", "node", { node_id: "a" }));
    tail.push(event("run-oldest", "done", { state: "complete" }));
    expect(tail.isKnown("run-oldest")).toBe(true);
    for (let i = 0; i < 1024; i += 1)
      tail.push(event(`run-fill-${String(i)}`, "node", { node_id: "a" }));
    expect(tail.isKnown("run-oldest")).toBe(false);
    // The run that TRIGGERED the cap (the very last one pushed) must never
    // evict itself, and must never end up with a duplicate-cursor ring
    // from a re-registration (PR #381 round 3's exact reproduction).
    const triggering = tail.snapshot("run-fill-1023");
    expect(triggering.next).toBe(1);
    expect(triggering.events).toHaveLength(1);
    expect(tail.isKnown("run-fill-1023")).toBe(true);
  });

  // PR #381 round 3: the discriminating case the previous cap test could
  // not catch — with NO done run anywhere to evict, the cap must leave
  // every live run's counters untouched (map grows instead), never evict
  // the run just pushed to, and never duplicate a cursor.
  it("never evicts a live run to make room — with every tracked run still live, the map is left to grow", () => {
    const tail = new WorkflowLiveTail();
    for (let i = 0; i < 1024; i += 1)
      tail.push(event(`run-live-${String(i)}`, "node", { node_id: "a" }));
    expect(tail.push(event("run-live-new", "node", { node_id: "a" }))).toBe(true);

    expect(tail.isKnown("run-live-new")).toBe(true);
    const newSnap = tail.snapshot("run-live-new");
    expect(newSnap.events).toHaveLength(1);
    expect(newSnap.next).toBe(1);
    expect(newSnap.dropped).toBe(0);

    for (let i = 0; i < 1024; i += 1) {
      expect(tail.isKnown(`run-live-${String(i)}`)).toBe(true);
      const snap = tail.snapshot(`run-live-${String(i)}`);
      expect(snap.next).toBe(1);
      expect(snap.dropped).toBe(0);
      expect(snap.events).toHaveLength(1);
    }
  });
});

describe("workflow_status.live_tail via WorkflowTool (issue #369)", () => {
  it("includes live_tail for a run known in this process; a fresh service reading the same durable row does not", async () => {
    const connection = tmpDb();
    try {
      const tail1 = new WorkflowLiveTail();
      const service1 = new WorkflowService({
        runtime: fakeRuntime(),
        idSource: () => "run-cross",
        store: productionOwnershipStore(connection.database, { holder: "proc-a" }),
        onLiveEvent: (liveEvent) => {
          tail1.push(liveEvent);
        },
      });
      const tool1 = new WorkflowTool(service1, undefined, tail1);
      expect(
        service1.start({
          meta: { name: "cross" },
          nodes: [{ id: "leaf", type: "agent", prompt: "go" }],
        }),
      ).toMatchObject({ run_id: "run-cross" });
      await service1.status("run-cross", true);
      const here = JSON.parse(await tool1.status({ run_id: "run-cross" })) as Readonly<
        Record<string, unknown>
      >;
      expect(here.live_tail).toBeDefined();
      const liveTailHere = here.live_tail as Readonly<Record<string, unknown>>;
      expect(Array.isArray(liveTailHere.events)).toBe(true);
      expect(typeof liveTailHere.next_cursor).toBe("number");
      expect(typeof liveTailHere.dropped).toBe("number");

      const tail2 = new WorkflowLiveTail();
      const service2 = new WorkflowService({
        runtime: fakeRuntime(),
        idSource: () => "unused",
        store: productionOwnershipStore(connection.database, { holder: "proc-b" }),
      });
      const tool2 = new WorkflowTool(service2, undefined, tail2);
      const elsewhere = JSON.parse(await tool2.status({ run_id: "run-cross" })) as Readonly<
        Record<string, unknown>
      >;
      expect(elsewhere.error).toBeUndefined();
      expect(elsewhere.live_tail).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("rejects a non-integer after_index instead of silently ignoring it", async () => {
    const service = new WorkflowService({
      runtime: fakeRuntime(),
      idSource: () => "run-bad-cursor",
    });
    const tool = new WorkflowTool(service, undefined, new WorkflowLiveTail());
    service.start({ meta: { name: "x" }, nodes: [{ id: "leaf", type: "agent", prompt: "go" }] });
    const out = JSON.parse(
      await tool.status({ run_id: "run-bad-cursor", after_index: "nope" }),
    ) as Readonly<Record<string, unknown>>;
    expect(out.error).toBeDefined();
  });

  it("shutdown() with a tail wired resolves, and the tail — passive, no timer of its own — keeps answering", async () => {
    const tail = new WorkflowLiveTail();
    const service = new WorkflowService({
      runtime: fakeRuntime(),
      idSource: () => "run-shutdown",
      onLiveEvent: (liveEvent) => {
        tail.push(liveEvent);
      },
    });
    service.start({ meta: { name: "x" }, nodes: [{ id: "leaf", type: "agent", prompt: "go" }] });
    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(() => tail.snapshot("run-shutdown")).not.toThrow();
  });
});

function jsonResponse(payload: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(payload);
}

function chatCompletion(
  id: string,
  message: Readonly<Record<string, unknown>>,
  finishReason: string,
): Readonly<Record<string, unknown>> {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: 0,
    model: "t369-chat-tail-model",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function toolCallMessage(
  callId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

function isLeafRequest(messages: readonly Readonly<Record<string, unknown>>[]): boolean {
  return messages.some(
    (message) =>
      typeof message.content === "string" && message.content.includes("isolated subagent"),
  );
}

function toolResultContent(
  messages: readonly Readonly<Record<string, unknown>>[],
  callId: string,
): string | undefined {
  const found = messages.find(
    (message) => message.role === "tool" && message.tool_call_id === callId,
  );
  return found === undefined ? undefined : String(found.content);
}

describe("chat.ts wires onLiveEvent into workflow_status.live_tail (issue #369, AC 6)", () => {
  it("a workflow_status tool call, via a real runChat turn, comes back with live_tail non-empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t369-chat-tail-"));
    roots.push(root);
    let mainCalls = 0;
    let runId: string | undefined;
    let statusContent: string | undefined;
    let leafArrived: () => void;
    const leafArrivedOnce = new Promise<void>((resolvePromise) => {
      leafArrived = resolvePromise;
    });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly messages: readonly Readonly<Record<string, unknown>>[];
        };
        const respond = (payload: Readonly<Record<string, unknown>>): void => {
          const text = jsonResponse(payload);
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(text)),
          });
          response.end(text);
        };
        if (isLeafRequest(body.messages)) {
          leafArrived();
          setTimeout(() => {
            respond(chatCompletion("leaf", { role: "assistant", content: "leaf done" }, "stop"));
          }, 200);
          return;
        }
        if (runId === undefined) {
          const runResult = toolResultContent(body.messages, "call-run-workflow");
          if (runResult !== undefined)
            runId = (JSON.parse(runResult) as { run_id?: string }).run_id;
        }
        if (statusContent === undefined)
          statusContent = toolResultContent(body.messages, "call-workflow-status");
        mainCalls += 1;
        if (mainCalls === 1) {
          respond(
            chatCompletion(
              "main-1",
              toolCallMessage("call-run-workflow", "run_workflow", {
                spec: {
                  meta: { name: "tail-chat" },
                  nodes: [{ id: "a", type: "agent", prompt: "do it" }],
                },
              }),
              "tool_calls",
            ),
          );
          return;
        }
        if (mainCalls === 2) {
          void leafArrivedOnce.then(() => {
            respond(
              chatCompletion(
                "main-2",
                toolCallMessage("call-workflow-status", "workflow_status", { run_id: runId }),
                "tool_calls",
              ),
            );
          });
          return;
        }
        respond(chatCompletion("main-3", { role: "assistant", content: "done" }, "stop"));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t369-chat-tail-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T369 chat tail probe",
        description: "Local in-memory composition-root probe (issue #369).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t369-chat-tail-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const result = await runChat({
        input: "run the tail-chat workflow",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t369-chat-tail-model"],
          ["--json", true],
          ["--no-input", true],
        ]),
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
      });
      expect(result.code).toBe(0);
      expect(statusContent).toBeDefined();
      const parsed = JSON.parse(String(statusContent)) as Readonly<Record<string, unknown>>;
      const liveTail = parsed.live_tail as Readonly<Record<string, unknown>> | undefined;
      expect(liveTail).toBeDefined();
      expect(Array.isArray(liveTail?.events)).toBe(true);
      expect((liveTail?.events as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await closeServer(server);
    }
  });
});

function sseEvent(delta: Readonly<Record<string, unknown>>, finishReason: string | null): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }], usage: null })}\n\n`;
}

function sseTextTurn(text: string): string {
  return `${sseEvent({ content: text }, null)}${sseEvent({}, "stop")}data: [DONE]\n\n`;
}

function sseToolCallTurn(
  callId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): string {
  const call = { index: 0, id: callId, function: { name, arguments: JSON.stringify(args) } };
  return `${sseEvent({ tool_calls: [call] }, null)}${sseEvent({}, "tool_calls")}data: [DONE]\n\n`;
}

const dashboardMessageQueues = new WeakMap<
  WebSocket,
  { readonly queue: string[]; readonly waiters: ((value: string) => void)[] }
>();

function queueFor(ws: WebSocket): {
  readonly queue: string[];
  readonly waiters: ((value: string) => void)[];
} {
  let state = dashboardMessageQueues.get(ws);
  if (state === undefined) {
    state = { queue: [], waiters: [] };
    dashboardMessageQueues.set(ws, state);
    ws.on("message", (data) => {
      const text = Buffer.from(data as Buffer).toString("utf8");
      const waiter = state?.waiters.shift();
      if (waiter !== undefined) waiter(text);
      else state?.queue.push(text);
    });
  }
  return state;
}

function nextMessage(ws: WebSocket): Promise<string> {
  const state = queueFor(ws);
  const queued = state.queue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolvePromise) => state.waiters.push(resolvePromise));
}

describe("dashboard.ts wires onLiveEvent into workflow_status.live_tail (issue #369, AC 6)", () => {
  it("a workflow_status tool call, via a real runDashboard WS turn, comes back with live_tail non-empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t369-dashboard-tail-"));
    roots.push(root);
    let mainCalls = 0;
    let runId: string | undefined;
    let statusContent: string | undefined;
    let leafArrived: () => void;
    const leafArrivedOnce = new Promise<void>((resolvePromise) => {
      leafArrived = resolvePromise;
    });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly messages: readonly Readonly<Record<string, unknown>>[];
        };
        const respond = (text: string): void => {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "content-length": String(Buffer.byteLength(text)),
          });
          response.end(text);
        };
        if (isLeafRequest(body.messages)) {
          leafArrived();
          setTimeout(() => {
            respond(sseTextTurn("leaf done"));
          }, 200);
          return;
        }
        if (runId === undefined) {
          const runResult = toolResultContent(body.messages, "call-run-workflow");
          if (runResult !== undefined)
            runId = (JSON.parse(runResult) as { run_id?: string }).run_id;
        }
        if (statusContent === undefined)
          statusContent = toolResultContent(body.messages, "call-workflow-status");
        mainCalls += 1;
        if (mainCalls === 1) {
          respond(
            sseToolCallTurn("call-run-workflow", "run_workflow", {
              spec: {
                meta: { name: "tail-dashboard" },
                nodes: [{ id: "a", type: "agent", prompt: "do it" }],
              },
            }),
          );
          return;
        }
        if (mainCalls === 2) {
          void leafArrivedOnce.then(() => {
            respond(sseToolCallTurn("call-workflow-status", "workflow_status", { run_id: runId }));
          });
          return;
        }
        respond(sseTextTurn("done"));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t369-dashboard-tail-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T369 dashboard tail probe",
        description: "Local in-memory composition-root probe (issue #369).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t369-dashboard-tail-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const stderrLines: string[] = [];
      let shutdown: (() => void) | undefined;
      const options: DashboardCommandOptions = {
        flags: new Map([
          ["--provider", provider],
          ["--model", "t369-dashboard-tail-model"],
        ]),
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
        stderr: (text) => stderrLines.push(text),
        port: 0,
        registerShutdownTrigger: (handler) => {
          shutdown = handler;
        },
      };
      const donePromise = runDashboard(options);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      const boundLine = stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
      const port = Number(boundLine?.match(/:(\d+)\n$/)?.[1]);
      const wsLine = stderrLines.find((line) => line.startsWith("WebSocket:"));
      const token = wsLine?.match(/token=([^\n]+)\n$/)?.[1];
      expect(token).toBeDefined();

      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws?token=${String(token)}`);
      await nextMessage(ws); // gateway.ready
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: "create", method: "session.create", params: {} }),
      );
      const createResult = JSON.parse(await nextMessage(ws)) as { result: { session_id: string } };
      await nextMessage(ws); // session.info
      const sessionId = createResult.result.session_id;

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "prompt.submit",
          params: { session_id: sessionId, text: "run the tail-dashboard workflow" },
        }),
      );
      await nextMessage(ws); // rpc-ok
      let complete: { params: { type: string; payload: unknown } } | undefined;
      while (complete === undefined) {
        const frame = JSON.parse(await nextMessage(ws)) as {
          params: { type: string; payload: unknown };
        };
        if (frame.params.type === "message.complete") complete = frame;
      }
      expect((complete.params.payload as { status: string }).status).toBe("complete");
      ws.close();

      expect(statusContent).toBeDefined();
      const parsed = JSON.parse(String(statusContent)) as Readonly<Record<string, unknown>>;
      const liveTail = parsed.live_tail as Readonly<Record<string, unknown>> | undefined;
      expect(liveTail).toBeDefined();
      expect(Array.isArray(liveTail?.events)).toBe(true);
      expect((liveTail?.events as unknown[]).length).toBeGreaterThan(0);

      shutdown?.();
      await donePromise;
    } finally {
      await closeServer(server);
    }
  });
});
