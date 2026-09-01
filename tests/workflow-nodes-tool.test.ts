import { describe, expect, it } from "vitest";

import {
  ConversationRuntime,
  type ConversationRepository,
  type ModelRequest,
  type ModelTransport,
  type TurnCommit,
} from "../src/conversation/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";
import { composeDispatch, RegistryToolDispatcher } from "../src/tools/index.js";
import {
  Budget,
  WorkflowEngine,
  WorkflowService,
  WorkflowTool,
  workflowToolHandlers,
  validateSpec,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
} from "../src/workflow/index.js";

const meter = {
  inputTokens: 2,
  outputTokens: 3,
  cacheReadTokens: 5,
  cacheWriteTokens: 7,
  reasoningTokens: 11,
} as const;

const ok = (output: unknown): ChildResult => ({
  status: "complete",
  output,
  usage: meter,
  provider: "stub",
  model: "canned",
});

class QueueChildren implements ChildRuntime {
  readonly requests: ChildSpawnRequest[] = [];
  readonly cancelled: string[] = [];
  readonly steered: string[] = [];
  private readonly scripts: ChildResult[][];
  private readonly active = new Map<string, ChildResult[]>();

  constructor(scripts: ChildResult[][]) {
    this.scripts = scripts.map((script) => [...script]);
  }

  spawn(request: ChildSpawnRequest): string {
    const id = `leaf-${String(this.requests.length + 1)}`;
    this.requests.push(request);
    this.active.set(id, this.scripts.shift() ?? []);
    return id;
  }

  collect(id: string, _options: ChildCollectOptions): ChildResult {
    return this.active.get(id)?.shift() ?? { status: "failed", output: "missing" };
  }

  steer(_id: string, prompt: string): void {
    this.steered.push(prompt);
  }

  cancel(id: string): void {
    this.cancelled.push(id);
  }
}

function spec(raw: unknown) {
  const parsed = validateSpec(raw);
  if ("issues" in parsed) throw new Error(parsed.message);
  return parsed;
}

describe("remaining workflow node strategies", () => {
  it("verify fails closed when every skeptic dies", async () => {
    const runtime = new QueueChildren([
      [{ status: "failed", output: "dead-a" }],
      [{ status: "failed", output: "dead-b" }],
    ]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "verify" },
        nodes: [{ id: "v", type: "verify", finding: "claim", skeptics: 2, kill_if_majority_refute: true }],
      }),
    );
    expect(result.outputs.v).toMatchObject({ survived: false, refuted: 0, skeptics: 0 });
    expect(result.faults).toHaveLength(3);
  });

  it("verify includes the authored lens and discards a schema-invalid skeptic", async () => {
    const runtime = new QueueChildren([[
      ok({ unexpected: true }),
      ok({ unexpected: true }),
      ok({ unexpected: true }),
    ]]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "verify-schema" },
        nodes: [{ id: "v", type: "verify", finding: "CLAIM", skeptics: 1, lenses: ["SECURITY-LENS"] }],
      }),
    );
    expect(runtime.requests[0]?.prompt).toContain("SECURITY-LENS");
    expect(runtime.steered).toHaveLength(2);
    expect(result.outputs.v).toMatchObject({ finding: null, survived: false, skeptics: 0 });
    expect(result.faults.some((fault) => fault.includes("fail-closed"))).toBe(true);
  });

  it("judge panel synthesizes a scored winner and dead synthesis is null", async () => {
    const runtime = new QueueChildren([
      [ok("draft")],
      [ok({ score: 9 })],
      [{ status: "failed", output: "synth dead" }],
    ]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "judge" },
        nodes: [
          {
            id: "j",
            type: "judge_panel",
            attempts: ["draft prompt"],
            judges: 1,
            synthesize: { prompt: "polish ${winner}" },
          },
        ],
      }),
    );
    expect(result.outputs.j).toBeNull();
    expect(runtime.requests).toHaveLength(3);
  });

  it("does not reserve a synthesis leaf when synthesize is absent", async () => {
    const runtime = new QueueChildren([[ok("draft")], [ok({ score: 9 })]]);
    const result = await new WorkflowEngine({
      runtime,
      budget: new Budget({ maxFanout: 2, lifetime: 2 }),
    }).run(
      spec({
        meta: { name: "judge-no-synth" },
        nodes: [
          { id: "j", type: "judge_panel", attempts: ["draft"], judges: 1, synthesize: null },
        ],
      }),
    );
    expect(result.outputs.j).toBe("draft");
    expect(result.capTrips).toBe(0);
    expect(runtime.requests).toHaveLength(2);
  });

  it("parses a textual JSON judge score through the fixed schema", async () => {
    const runtime = new QueueChildren([[ok("draft")], [ok('{"score":9,"rationale":"ok"}')]]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "judge-text-score" },
        nodes: [{ id: "j", type: "judge_panel", attempts: ["draft"], judges: 1, synthesize: null }],
      }),
    );
    expect(result.outputs.j).toBe("draft");
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.steered).toHaveLength(0);
  });

  it("steers a malformed judge score twice and discards it fail-closed", async () => {
    const invalid = ok('{"unexpected":true}');
    const runtime = new QueueChildren([[ok("draft")], [invalid, invalid, invalid]]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "judge-invalid-score" },
        nodes: [{ id: "j", type: "judge_panel", attempts: ["draft"], judges: 1, synthesize: null }],
      }),
    );
    expect(result.outputs.j).toBeNull();
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.steered).toHaveLength(2);
    expect(result.faults.some((fault) => fault.includes("attempt unscored"))).toBe(true);
  });

  it("always appends the winner to the judge synthesis prompt", async () => {
    const runtime = new QueueChildren([[ok("BEST-CANDIDATE")], [ok({ score: 9 })], [ok("FINAL")]]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "judge-winner-prompt" },
        nodes: [{
          id: "j",
          type: "judge_panel",
          attempts: ["draft"],
          judges: 1,
          synthesize: { prompt: "polish this" },
        }],
      }),
    );
    expect(result.outputs.j).toBe("FINAL");
    expect(runtime.requests[2]?.prompt).toBe("polish this\n\nWINNER:\nBEST-CANDIDATE");
  });

  it("loop keeps useful rounds and stops after an empty answer", async () => {
    const runtime = new QueueChildren([[ok("one")], [ok("")]]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "loop" },
        nodes: [
          {
            id: "l",
            type: "loop_until_dry",
            body: { prompt: "round ${round} after ${so_far}" },
            stop_after_k_empty: 1,
            max_rounds: 4,
          },
        ],
      }),
    );
    expect(result.outputs.l).toEqual(["one"]);
    expect(runtime.requests).toHaveLength(2);
  });

  it("gate skips reviewer for an empty draft", async () => {
    const runtime = new QueueChildren([[ok("")], [ok("draft")], [ok({ ok: true, feedback: "" })]]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "gate" },
        nodes: [
          {
            id: "g",
            type: "gate",
            body: { prompt: "write" },
            validator: "review",
            attempts: 2,
          },
        ],
      }),
    );
    expect(result.outputs.g).toBe("draft");
    expect(runtime.requests.map((request) => request.causalContext.role)).toEqual([
      "gate.body",
      "gate.body",
      "gate.reviewer",
    ]);
  });

  it("uses structural-only preflight for a sequential gate", async () => {
    const eightTokens = (output: unknown): ChildResult => ({
      ...ok(output),
      usage: { ...meter, inputTokens: 4, outputTokens: 4 },
    });
    const runtime = new QueueChildren([[eightTokens("DRAFT")], [eightTokens({ ok: true, feedback: "" })]]);
    const result = await new WorkflowEngine({
      runtime,
      budget: new Budget({ tokenBudget: 100 }),
    }).run(
      spec({
        meta: { name: "gate-soft-budget" },
        nodes: [{ id: "g", type: "gate", body: { prompt: "write" }, validator: "review", attempts: 1 }],
      }),
    );
    expect(runtime.requests).toHaveLength(2);
    expect(result.outputs.g).toBe("DRAFT");
    expect(result.status).toBe("complete");
  });

  it("parses a textual JSON gate verdict and approves the first draft", async () => {
    const runtime = new QueueChildren([[ok("DRAFT")], [ok('{"ok":true,"feedback":""}')]]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "gate-text-verdict" },
        nodes: [{ id: "g", type: "gate", body: { prompt: "write" }, validator: "review", attempts: 2 }],
      }),
    );
    expect(result.outputs.g).toBe("DRAFT");
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.steered).toHaveLength(0);
  });

  it("steers a malformed gate verdict twice and fails closed", async () => {
    const invalid = ok('{"unexpected":true}');
    const runtime = new QueueChildren([[ok("DRAFT")], [invalid, invalid, invalid]]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "gate-invalid-verdict" },
        nodes: [{ id: "g", type: "gate", body: { prompt: "write" }, validator: "review", attempts: 1 }],
      }),
    );
    expect(result.outputs.g).toBeNull();
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.steered).toHaveLength(2);
    expect(result.faults.some((fault) => fault.includes("gate exhausted"))).toBe(true);
  });

  it("completeness forces its structured shape", async () => {
    const runtime = new QueueChildren([[ok({ complete: false, missing: ["tests"] })]]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "complete" },
        nodes: [{ id: "c", type: "completeness_check", task: "ship", results: ["code"] }],
      }),
    );
    expect(result.outputs.c).toEqual({ complete: false, missing: ["tests"] });
  });

  it("nested workflow shares execution and folds outputs", async () => {
    const runtime = new QueueChildren([[ok("inner-output")]]);
    const result = await new WorkflowEngine({
      runtime,
      runId: "shared-run",
      loader: () => ({
        meta: { name: "inner", version: 1 },
        nodes: [{ id: "inner", type: "agent", prompt: "inner" }],
      }),
    }).run(
      spec({
        meta: { name: "outer" },
        nodes: [{ id: "nested", type: "workflow", ref: "inner", args: {} }],
      }),
    );
    expect(result.outputs.nested).toEqual({ inner: "inner-output" });
    expect(runtime.requests[0]?.causalContext.runId).toBe("shared-run");
    expect(runtime.requests[0]?.causalContext.nodePath).toEqual(["nested", "inner"]);
  });

  it("folds nested faults, node counts and all five cost meters", async () => {
    const runtime = new QueueChildren([[{ status: "failed", output: "inner dead", usage: meter }]]);
    const result = await new WorkflowEngine({
      runtime,
      loader: () => ({ meta: { name: "inner" }, nodes: [{ id: "leaf", type: "agent", prompt: "x", retries: 0 }] }),
    }).run(
      spec({ meta: { name: "outer" }, nodes: [{ id: "sub", type: "workflow", ref: "inner" }] }),
    );
    expect(result.nodesTotal).toBe(2);
    expect(result.nullCount).toBe(1);
    expect(result.tokensIn).toBe(2);
    expect(result.cacheReadTokens).toBe(5);
    expect(result.nodeCosts["sub[inner]:leaf"]?.usage.reasoningTokens).toBe(11);
    expect(result.faults[0]).toContain("sub[inner]");
  });

  it("shares the outer token budget with nested leaves", async () => {
    const runtime = new QueueChildren([[ok("inner")], [ok("must-not-run")]]);
    const result = await new WorkflowEngine({
      runtime,
      budget: new Budget({ tokenBudget: 4 }),
      loader: () => ({
        meta: { name: "inner" },
        nodes: [{ id: "leaf", type: "agent", prompt: "inner" }],
      }),
    }).run(
      spec({
        meta: { name: "outer-budget" },
        nodes: [
          { id: "sub", type: "workflow", ref: "inner" },
          { id: "after", type: "agent", prompt: "after", depends_on: ["sub"] },
        ],
      }),
    );
    expect(runtime.requests).toHaveLength(1);
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("token_budget");
  });

  it("turns nesting depth two into one engine fault without spawning", async () => {
    const runtime = new QueueChildren([]);
    const result = await new WorkflowEngine({
      runtime,
      loader: (reference) =>
        reference === "middle"
          ? { meta: { name: "middle" }, nodes: [{ id: "too-deep", type: "workflow", ref: "inner" }] }
          : { meta: { name: "inner" }, nodes: [{ id: "leaf", type: "agent", prompt: "x" }] },
    }).run(
      spec({ meta: { name: "outer-depth" }, nodes: [{ id: "sub", type: "workflow", ref: "middle" }] }),
    );
    expect(result.engineFaults).toBe(1);
    expect(result.faults.some((fault) => fault.includes("nesting exceeds depth"))).toBe(true);
    expect(runtime.requests).toHaveLength(0);
  });

  it("extracts a forced StructuredOutput tool call and counts text fallback", async () => {
    const runtime = new QueueChildren([
      [{ ...ok("ignored"), toolCalls: [{ name: "StructuredOutput", arguments: { value: 3 } }] }],
      [{ ...ok('{"value":4}'), toolCalls: [] }],
    ]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({
        meta: { name: "structured" },
        nodes: [
          { id: "forced", type: "agent", prompt: "a", tool_less: true, schema: { type: "object", required: ["value"], properties: { value: { type: "integer" } } } },
          { id: "fallback", type: "agent", prompt: "b", tool_less: true, schema: { type: "object", required: ["value"], properties: { value: { type: "integer" } } } },
        ],
      }),
    );
    expect(result.outputs).toEqual({ forced: { value: 3 }, fallback: { value: 4 } });
    expect(result.forcingFallbacks).toBe(1);
  });

  it("checkpoint without answer pauses and spawns nothing", async () => {
    const runtime = new QueueChildren([]);
    const result = await new WorkflowEngine({ runtime }).run(
      spec({ meta: { name: "checkpoint" }, nodes: [{ id: "cp", type: "checkpoint", prompt: "Approve?" }] }),
    );
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("checkpoint");
    expect(result.checkpoint).toMatchObject({ node_id: "cp", prompt: "Approve?" });
    expect(runtime.requests).toHaveLength(0);
  });
});

class MemoryRepository implements ConversationRepository {
  private readonly sessions = new Map<string, { systemPrompt: string; model: string; cwd: string }>();
  private readonly messages = new Map<string, readonly Readonly<Record<string, unknown>>[]>();

  createSession(input: { readonly id: string; readonly systemPrompt: string; readonly model: string; readonly cwd: string }): void {
    this.sessions.set(input.id, { systemPrompt: input.systemPrompt, model: input.model, cwd: input.cwd });
  }
  session(id: string) {
    return this.sessions.get(id) ?? null;
  }
  loadMessages(id: string) {
    return this.messages.get(id) ?? [];
  }
  commitTurn(commit: TurnCommit): void {
    this.messages.set(commit.sessionId, commit.messages ?? [commit.user, commit.assistant]);
  }
  commitUsage(): void {}
  summary() {
    return null;
  }
}

const modelUsage = { ...meter };
const response = (overrides: Partial<NormalizedResponse> = {}): NormalizedResponse => ({
  content: "done",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage: modelUsage,
  providerData: null,
  ...overrides,
});

class CannedModel implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly responses: readonly NormalizedResponse[]) {}
  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(request);
    const next = this.responses[this.requests.length - 1];
    if (next === undefined) throw new Error("missing canned response");
    return Promise.resolve(next);
  }
  close(): void {}
}

describe("public workflow tool path", () => {
  it("crosses real ConversationRuntime dispatch and returns the completed run", async () => {
    const children = new QueueChildren([[ok("leaf-output")]]);
    const service = new WorkflowService({ runtime: children, idSource: () => "run-1" });
    const specArg = {
      meta: { name: "public" },
      nodes: [{ id: "agent", type: "agent", prompt: "do it" }],
    };
    const model = new CannedModel([
      response({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call-run",
            name: "run_workflow",
            arguments: JSON.stringify({ spec: specArg }),
            providerData: null,
          },
        ],
      }),
      response({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call-status",
            name: "workflow_status",
            arguments: JSON.stringify({ run_id: "run-1", wait: true }),
            providerData: null,
          },
        ],
      }),
      response({ content: "workflow complete" }),
    ]);
    const dispatch = composeDispatch(
      (name) => Promise.resolve(`{"error": "unexpected ${name}"}`),
      workflowToolHandlers(service),
    );
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport: model,
      promptSnapshot: () => "frozen",
      toolDispatcher: new RegistryToolDispatcher(dispatch),
      idSource: () => "chat-1",
      clock: () => 1,
      maxIterations: 4,
    });
    const result = await runtime.runTurn({
      input: "run it",
      provider: "stub",
      model: "canned",
      cwd: "/tmp",
    });
    expect(result.response.content).toBe("workflow complete");
    expect(result.toolCalls?.map((call) => call.name)).toEqual(["run_workflow", "workflow_status"]);
    expect(result.toolCalls?.[0]?.result).toBe(
      '{"ok": true, "run_id": "run-1", "status": "started"}',
    );
    expect(result.toolCalls?.[1]?.result).toContain('"outputs": {"agent": "leaf-output"}');
    expect(model.requests[2]?.messages).toHaveLength(5);
  });

  it("returns the pinned oracle start envelope shape without extra fields", () => {
    const service = new WorkflowService({
      runtime: new QueueChildren([[ok("leaf-output")]]),
      idSource: () => "run-1",
    });
    const out = service.start(
      { meta: { name: "public" }, nodes: [{ id: "agent", type: "agent", prompt: "do it" }] },
      {},
    );
    expect(out).toEqual({ run_id: "run-1", status: "started" });
  });

  it("rejects malformed public args with named causes", () => {
    const tool = new WorkflowTool(new WorkflowService({ runtime: new QueueChildren([]) }));
    expect(tool.run({ spec: "bad" })).toContain("'spec' must be an object");
    expect(tool.run({ spec: { meta: { name: "x" }, nodes: [] } })).toContain(
      "invalid workflow spec",
    );
  });
});
