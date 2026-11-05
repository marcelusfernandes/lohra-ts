// Issue #982 (S6 do épico #976, desenho §6 e §8): o nó `call` — `read_file` ou
// `web_fetch` SEM modelo, pela porta `ChildRuntime.callTool` do S5 (#978). O que
// prende:
//   - o sucesso: a saída é o envelope da tool parseado (`${n.campo}` o lê), o
//     request leva a tool, os args já resolvidos, o `timeout` do nó e o contexto
//     causal do nó; nenhum leaf, nenhum token, nenhuma linha de custo;
//   - a repetição: `error`/`timeout` retentam até `retries`, `denied` nunca; o
//     esgotado é fault com tool, status, tentativas e causa, e saída null, sem
//     célula;
//   - o orçamento: cada tentativa faz `checkFanout(1)` + `charge()`, sem tokens;
//     lifetime esgotado vira `cap_trips`, e a falha anterior não se perde;
//   - o run parado: nenhuma chamada, e nenhuma retentativa depois de parar;
//   - a falha que fecha: a raiz de um `${ref}` de `args` que é um nó morto, ou um
//     campo sem valor, dá `<id>: upstream null` ANTES de qualquer chamada;
//   - o resume: a célula (hash pinado, custo zero) é reaproveitada e a tool não é
//     chamada de novo; uma chamada que falhou não grava célula;
//   - o runtime sem porta, ou com uma porta que lança, dá engine fault;
//   - o engine AGUARDA a porta (o deadline dela é `unref()`): o run só termina
//     depois da chamada, e um timer com ref segura o processo enquanto ela pende.
// O ledger (`tool.*`), o resume durável e o preview ficam em
// `tests/workflow-cache-preview-flow.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";

import { usage } from "../src/pricing/usage.js";
import { Budget } from "../src/workflow/budget.js";
import { contentHash, MemoryWorkflowCache } from "../src/workflow/cache.js";
import { callSubId } from "../src/workflow/call-tools.js";
import { idleRunControl } from "../src/workflow/engine-options.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { runCall } from "../src/workflow/flow-call.js";
import { FLOW_STRATEGIES } from "../src/workflow/flow-strategies.js";
import { DEFAULT_CALL_TIMEOUT_SECONDS } from "../src/workflow/nodes.js";
import type {
  Awaitable,
  CallToolRequest,
  CallToolResult,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import { validateSpec } from "../src/workflow/schema.js";
import { Node, WorkflowSpec } from "../src/workflow/types.js";

const NAME = "call-run";

type Script = (request: CallToolRequest, index: number) => Awaitable<CallToolResult>;

const envelope = (fields: Record<string, unknown> = {}): CallToolResult => ({
  status: "ok",
  output: JSON.stringify({ ok: true, ...fields }),
});

const failure = (status: "error" | "denied" | "timeout", message: string): CallToolResult => ({
  status,
  output: JSON.stringify({ error: message }),
});

/** A runtime with the model-free port; its leaves (a downstream agent) answer at once. */
class PortRuntime implements ChildRuntime {
  readonly calls: CallToolRequest[] = [];
  readonly spawned: ChildSpawnRequest[] = [];

  constructor(private readonly script: Script = () => envelope()) {}

  callTool(request: CallToolRequest): Awaitable<CallToolResult> {
    this.calls.push(request);
    return this.script(request, this.calls.length - 1);
  }

  spawn(request: ChildSpawnRequest): string {
    this.spawned.push(request);
    return `leaf-${String(this.spawned.length)}`;
  }

  collect(): ChildResult {
    return {
      status: "complete",
      output: { answer: "done" },
      usage: usage({ inputTokens: 1, outputTokens: 1 }),
    };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): LeafSandboxHandle {
    return { dispose: (): void => undefined };
  }
}

/** The same runtime without `callTool`: what every runtime built before #978 is. */
class PortlessRuntime implements ChildRuntime {
  spawn(): string {
    return "leaf";
  }
  collect(): ChildResult {
    return { status: "failed", output: "no leaf here" };
  }
  steer(): void {}
  cancel(): void {}
}

/** Remembers every write, with the cost it came with. */
class RecordingCache extends MemoryWorkflowCache {
  readonly puts: {
    readonly hash: string;
    readonly nodeId: string;
    readonly output: unknown;
    readonly cost: Parameters<MemoryWorkflowCache["put"]>[4];
  }[] = [];

  override put(
    runId: string,
    hash: string,
    nodeId: string,
    output: unknown,
    cost: Parameters<MemoryWorkflowCache["put"]>[4],
  ): boolean {
    this.puts.push({ hash, nodeId, output, cost });
    return super.put(runId, hash, nodeId, output, cost);
  }
}

function spec(nodes: readonly Record<string, unknown>[]): WorkflowSpec {
  const result = validateSpec({ meta: { name: NAME }, nodes });
  if ("issues" in result) throw new Error(result.message);
  return result;
}

interface Options {
  readonly cache?: MemoryWorkflowCache;
  readonly budget?: Budget;
  readonly control?: ReturnType<typeof idleRunControl>;
}

function engineFor(runtime: ChildRuntime, options: Options = {}): WorkflowEngine {
  return new WorkflowEngine({
    runtime,
    runId: "run",
    logError: () => undefined,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.control === undefined ? {} : { control: options.control }),
  });
}

const run = (
  runtime: ChildRuntime,
  workflow: WorkflowSpec,
  args: Record<string, unknown> = {},
  options: Options = {},
) => engineFor(runtime, options).run(workflow, args);

const fetchNode = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "fetch",
  type: "call",
  tool: "web_fetch",
  args: { url: "${args.url}" },
  ...fields,
});

const ARGS = { url: "https://a.test/page" };
const PAGE = { url: "https://a.test/page", text: "hello page", untrusted: true };
const one = (fields: Record<string, unknown> = {}): WorkflowSpec => spec([fetchNode(fields)]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("call is registered in the strategy table (#982)", () => {
  it("has its strategy in FLOW_STRATEGIES, so engine.ts did not change", () => {
    expect(FLOW_STRATEGIES.call).toBe(runCall);
  });
});

describe("a call that works (#982)", () => {
  it("returns the tool's envelope parsed, with no leaf and no fault", async () => {
    const runtime = new PortRuntime(() => envelope(PAGE));
    const result = await run(runtime, one(), ARGS);
    expect(result.outputs.fetch).toEqual({ ok: true, ...PAGE });
    expect(result.faults).toEqual([]);
    expect(result.status).toBe("complete");
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.spawned).toEqual([]);
  });

  it("asks the port for the tool, with the args resolved and the node's own deadline", async () => {
    const runtime = new PortRuntime();
    await run(runtime, one({ timeout: 7 }), ARGS);
    const request = runtime.calls[0];
    expect(request?.name).toBe("web_fetch");
    expect(request?.args).toEqual({ url: "https://a.test/page" });
    expect(request?.timeoutSeconds).toBe(7);
  });

  it("falls to the default deadline when the node names none", async () => {
    const runtime = new PortRuntime();
    await run(runtime, one(), ARGS);
    expect(runtime.calls[0]?.timeoutSeconds).toBe(DEFAULT_CALL_TIMEOUT_SECONDS);
  });

  it("carries the node's causal identity, role 'call', attempt 0 and the cell as cellId", async () => {
    const runtime = new PortRuntime();
    await run(runtime, one(), ARGS);
    const causal = runtime.calls[0]?.causalContext;
    expect(causal).toMatchObject({
      runId: "run",
      nodePath: ["fetch"],
      role: "call",
      attempt: 0,
      cellId: contentHash(NAME, null, "fetch", "call", "web_fetch", { url: ARGS.url }),
    });
  });

  it("sends an empty args object when the node has none", async () => {
    const runtime = new PortRuntime();
    await run(runtime, spec([{ id: "read", type: "call", tool: "read_file" }]));
    expect(runtime.calls[0]?.args).toEqual({});
    expect(runtime.calls[0]?.name).toBe("read_file");
  });

  it("resolves a ref inside text, keeps a whole ref's type, and walks structures", async () => {
    const runtime = new PortRuntime();
    await run(
      runtime,
      one({
        tool: "read_file",
        args: {
          path: "dir/${args.name}.txt",
          limit: "${args.limit}",
          nested: { list: ["${args.name}", 5], flag: true },
        },
      }),
      { name: "notes", limit: 20 },
    );
    expect(runtime.calls[0]?.args).toEqual({
      path: "dir/notes.txt",
      limit: 20,
      nested: { list: ["notes", 5], flag: true },
    });
  });

  it("reads a field of an upstream node's output", async () => {
    const runtime = new PortRuntime();
    const workflow = spec([
      { id: "scan", type: "agent", prompt: "find the url" },
      fetchNode({ args: { url: "${scan.answer}" }, depends_on: ["scan"] }),
    ]);
    await run(runtime, workflow, {});
    expect(runtime.calls[0]?.args).toEqual({ url: "done" });
  });

  it("spends no token, adds no per-node cost and sends no leaf", async () => {
    const runtime = new PortRuntime(() => envelope(PAGE));
    const budget = new Budget();
    const result = await run(runtime, one({ retries: 2 }), ARGS, { budget });
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
    expect(budget.tokensSpent).toBe(0);
    expect(result.nodeCosts).toEqual({});
  });

  it("a later node reads the envelope with ${fetch.field}", async () => {
    const runtime = new PortRuntime(() => envelope(PAGE));
    const workflow = spec([
      fetchNode(),
      {
        id: "summary",
        type: "agent",
        prompt: "Summarise: ${fetch.text} (from ${fetch.url})",
        depends_on: ["fetch"],
      },
    ]);
    const result = await run(runtime, workflow, ARGS);
    expect(runtime.spawned.map((request) => request.prompt)).toEqual([
      "Summarise: hello page (from https://a.test/page)",
    ]);
    expect(result.status).toBe("complete");
  });

  it("a switch can branch on a field of the envelope", async () => {
    const runtime = new PortRuntime(() => envelope({ kind: "static" }));
    const workflow = spec([
      fetchNode(),
      {
        id: "route",
        type: "switch",
        value: "${fetch.kind}",
        cases: { static: null, dynamic: { prompt: "render it" } },
        depends_on: ["fetch"],
      },
    ]);
    const result = await run(runtime, workflow, ARGS);
    expect(result.outputs.route).toEqual({ case: "static", matched: true, output: null });
    expect(runtime.spawned).toEqual([]);
  });
});

describe("a call that fails is retried until `retries`, and never when denied (#982)", () => {
  it("retries an error and returns the attempt that worked", async () => {
    const runtime = new PortRuntime((_request, index) =>
      index === 0 ? failure("error", "boom") : envelope(PAGE),
    );
    const cache = new RecordingCache();
    const result = await run(runtime, one({ retries: 2 }), ARGS, { cache });
    expect(runtime.calls).toHaveLength(2);
    expect(result.outputs.fetch).toEqual({ ok: true, ...PAGE });
    expect(result.faults).toEqual([]);
    expect(cache.puts).toHaveLength(1);
  });

  it("gives every attempt its own attempt number and sub id, on the same cell", async () => {
    const runtime = new PortRuntime(() => failure("error", "boom"));
    await run(runtime, one({ retries: 2 }), ARGS);
    const causals = runtime.calls.map((request) => request.causalContext);
    expect(causals.map((causal) => causal.attempt)).toEqual([0, 1, 2]);
    expect(new Set(causals.map((causal) => causal.cellId)).size).toBe(1);
    expect(new Set(causals.map((causal) => callSubId(causal))).size).toBe(3);
  });

  it("an error that outlasts the retries is a fault with tool, status, attempts and cause", async () => {
    const runtime = new PortRuntime(() => failure("error", "could not fetch the page: boom"));
    const cache = new RecordingCache();
    const result = await run(runtime, one({ retries: 2 }), ARGS, { cache });
    expect(runtime.calls).toHaveLength(3);
    expect(result.outputs.fetch).toBeNull();
    expect(result.faults).toEqual([
      "fetch: call web_fetch error after 3 attempts: could not fetch the page: boom",
    ]);
    expect(result.status).toBe("degraded");
    expect(cache.puts).toEqual([]);
  });

  it("without `retries` a failure is one attempt, and the fault says so", async () => {
    const runtime = new PortRuntime(() => failure("error", "boom"));
    const result = await run(runtime, one(), ARGS);
    expect(runtime.calls).toHaveLength(1);
    expect(result.faults).toEqual(["fetch: call web_fetch error after 1 attempt: boom"]);
  });

  it("a timeout is retried like an error, and the fault says timeout", async () => {
    const runtime = new PortRuntime(() =>
      failure("timeout", "'web_fetch' did not finish within 5 s"),
    );
    const result = await run(runtime, one({ retries: 1, timeout: 5 }), ARGS);
    expect(runtime.calls).toHaveLength(2);
    expect(result.faults).toEqual([
      "fetch: call web_fetch timeout after 2 attempts: 'web_fetch' did not finish within 5 s",
    ]);
  });

  it("a denial is never retried, however many retries the node asks for", async () => {
    const runtime = new PortRuntime(() => failure("denied", "egress to a.test is not allowed"));
    const result = await run(runtime, one({ retries: 3 }), ARGS);
    expect(runtime.calls).toHaveLength(1);
    expect(result.outputs.fetch).toBeNull();
    expect(result.faults).toEqual([
      "fetch: call web_fetch denied after 1 attempt: egress to a.test is not allowed",
    ]);
  });

  it("stops at a denial that follows an error, and counts the attempts it made", async () => {
    const runtime = new PortRuntime((_request, index) =>
      index === 0 ? failure("timeout", "slow") : failure("denied", "no"),
    );
    const result = await run(runtime, one({ retries: 3 }), ARGS);
    expect(runtime.calls).toHaveLength(2);
    expect(result.faults).toEqual(["fetch: call web_fetch denied after 2 attempts: no"]);
  });

  it("an output that is not the tool's JSON still names a cause: the text itself", async () => {
    const runtime = new PortRuntime(() => ({ status: "denied", output: "ERROR: sandbox says no" }));
    const result = await run(runtime, one(), ARGS);
    expect(result.faults).toEqual([
      "fetch: call web_fetch denied after 1 attempt: ERROR: sandbox says no",
    ]);
  });

  it("a cause with no text still says so, instead of an empty fault", async () => {
    const runtime = new PortRuntime(() => ({ status: "error", output: "  " }));
    const result = await run(runtime, one(), ARGS);
    expect(result.faults).toEqual(["fetch: call web_fetch error after 1 attempt: (no detail)"]);
  });

  it("a long cause is cut, on one line", async () => {
    const message = `line one\n${"x".repeat(900)}`;
    const runtime = new PortRuntime(() => failure("error", message));
    const result = await run(runtime, one(), ARGS);
    const fault = result.faults[0] ?? "";
    expect(fault.length).toBeLessThan(450);
    expect(fault).not.toContain("\n");
    expect(fault).toContain("line one xxx");
    expect(fault.endsWith("…")).toBe(true);
  });

  it("an ok envelope that is not valid JSON is an error attempt, and is retried", async () => {
    const runtime = new PortRuntime(() => ({ status: "ok", output: '{"ok":true,"text":' }));
    const result = await run(runtime, one({ retries: 1 }), ARGS);
    expect(runtime.calls).toHaveLength(2);
    expect(result.outputs.fetch).toBeNull();
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]).toContain("call web_fetch error after 2 attempts");
    expect(result.faults[0]).toContain("not valid JSON");
  });
});

describe("every attempt is charged to the run's limits, and no token is (#982)", () => {
  it("charges one spawn per attempt", async () => {
    const budget = new Budget({ lifetime: 10 });
    const runtime = new PortRuntime(() => failure("error", "boom"));
    await run(runtime, one({ retries: 2 }), ARGS, { budget });
    expect(budget.lifetimeRemaining).toBe(7);
  });

  it("charges the single attempt of a call that works", async () => {
    const budget = new Budget({ lifetime: 10 });
    await run(new PortRuntime(), one(), ARGS, { budget });
    expect(budget.lifetimeRemaining).toBe(9);
  });

  it("an exhausted lifetime is a cap trip and the tool is never called", async () => {
    const budget = new Budget({ lifetime: 1 });
    budget.charge();
    const runtime = new PortRuntime();
    const result = await run(runtime, one(), ARGS, { budget });
    expect(runtime.calls).toEqual([]);
    expect(result.capTrips).toBe(1);
    expect(result.outputs.fetch).toBeNull();
    expect(result.faults).toEqual(["fetch: fan-out of 1 exceeds lifetime remaining 0"]);
  });

  it("a retry the limits refuse is a cap trip, and the failure before it is still named", async () => {
    const budget = new Budget({ lifetime: 1 });
    const runtime = new PortRuntime(() => failure("error", "boom"));
    const result = await run(runtime, one({ retries: 2 }), ARGS, { budget });
    expect(runtime.calls).toHaveLength(1);
    expect(result.capTrips).toBe(1);
    expect(result.outputs.fetch).toBeNull();
    expect(result.faults).toHaveLength(2);
    expect(result.faults[0]).toContain("fetch: call web_fetch error after 1 attempt: boom");
    expect(result.faults[1]).toBe("fetch: fan-out of 1 exceeds lifetime remaining 0");
  });
});

describe("a run that is stopped makes no call (#982)", () => {
  it("a pause that began before the first attempt means no call and no fault of its own", async () => {
    const control = idleRunControl();
    const runtime = new PortRuntime();
    const engine = engineFor(runtime, { control });
    engine.setFlowStrategyForTest("call", (deps, node, context) => {
      control.paused = true;
      return runCall(deps, node, context);
    });
    const result = await engine.run(one(), ARGS);
    expect(runtime.calls).toEqual([]);
    expect(result.outputs.fetch).toBeNull();
    expect(result.faults).toEqual([]);
  });

  it("a cancel that began before the first attempt means no call either", async () => {
    const control = idleRunControl();
    const runtime = new PortRuntime();
    const engine = engineFor(runtime, { control });
    engine.setFlowStrategyForTest("call", (deps, node, context) => {
      control.cancelled = true;
      return runCall(deps, node, context);
    });
    const result = await engine.run(one(), ARGS);
    expect(runtime.calls).toEqual([]);
    expect(result.faults).toEqual([]);
  });

  it.each(["paused", "cancelled"] as const)(
    "a run that is %s while an attempt is in flight does not retry",
    async (flag) => {
      const control = idleRunControl();
      const runtime = new PortRuntime(() => {
        control[flag] = true;
        return failure("error", "boom");
      });
      const cache = new RecordingCache();
      const result = await run(runtime, one({ retries: 3 }), ARGS, { control, cache });
      expect(runtime.calls).toHaveLength(1);
      expect(result.outputs.fetch).toBeNull();
      expect(cache.puts).toEqual([]);
    },
  );

  it("a run stopped while the attempt works still keeps what the call returned", async () => {
    const control = idleRunControl();
    const runtime = new PortRuntime(() => {
      control.paused = true;
      return envelope(PAGE);
    });
    const result = await run(runtime, one(), ARGS, { control });
    expect(runtime.calls).toHaveLength(1);
    expect(result.outputs.fetch).toEqual({ ok: true, ...PAGE });
  });
});

describe("a call fails closed on a value it cannot fill in (#982)", () => {
  it("a ref whose root is a node that failed is `upstream null`, with no call", async () => {
    const workflow = spec([
      { id: "scan", type: "agent", prompt: "find" },
      fetchNode({ args: { url: "${scan.answer}" }, depends_on: ["scan"] }),
    ]);
    const dying = new PortRuntime();
    dying.collect = (): ChildResult => ({ status: "failed", output: "dead" });
    const result = await run(dying, workflow);
    expect(dying.calls).toEqual([]);
    expect(result.outputs.fetch).toBeNull();
    expect(result.faults).toContain("fetch: upstream null");
    expect(result.faults.some((fault) => fault.includes("${scan.answer}"))).toBe(true);
  });

  it("a field the root does not have is `upstream null` too, and names the ref", async () => {
    const runtime = new PortRuntime();
    const result = await run(runtime, one(), { other: 1 });
    expect(runtime.calls).toEqual([]);
    expect(result.outputs.fetch).toBeNull();
    expect(result.faults).toEqual(["fetch: upstream null", "fetch: no value for ${args.url}"]);
  });

  it("names every ref with no value, once each", async () => {
    const runtime = new PortRuntime();
    const result = await run(
      runtime,
      one({ args: { a: "${args.one}", b: "x ${args.one} ${args.two}", c: "${args.three}" } }),
      { three: 3 },
    );
    expect(runtime.calls).toEqual([]);
    expect(result.faults).toEqual([
      "fetch: upstream null",
      "fetch: no value for ${args.one}, ${args.two}",
    ]);
  });

  it("a falsy value is a value: 0, false and the empty string go through", async () => {
    const runtime = new PortRuntime();
    await run(
      runtime,
      one({ tool: "read_file", args: { a: "${args.zero}", b: "${args.no}", c: "${args.blank}" } }),
      { zero: 0, no: false, blank: "" },
    );
    expect(runtime.calls[0]?.args).toEqual({ a: 0, b: false, c: "" });
  });

  it("a literal null the author wrote is theirs to send", async () => {
    const runtime = new PortRuntime();
    await run(runtime, one({ args: { url: "https://a.test", extra: null } }), {});
    expect(runtime.calls[0]?.args).toEqual({ url: "https://a.test", extra: null });
  });
});

describe("a resume does not call the tool again (#982)", () => {
  it("stores the envelope under the pinned cell, with zero cost, owned by the node", async () => {
    const cache = new RecordingCache();
    const runtime = new PortRuntime(() => envelope(PAGE));
    await run(runtime, one(), ARGS, { cache });
    expect(cache.puts).toHaveLength(1);
    const put = cache.puts[0];
    expect(put?.hash).toBe(
      contentHash(NAME, null, "fetch", "call", "web_fetch", { url: ARGS.url }),
    );
    expect(put?.nodeId).toBe("fetch");
    expect(put?.output).toEqual({ ok: true, ...PAGE });
    expect(put?.cost).toEqual(usage());
  });

  it("the second run replays the cell: same output, no call, no cost", async () => {
    const cache = new MemoryWorkflowCache();
    const first = new PortRuntime(() => envelope(PAGE));
    await run(first, one(), ARGS, { cache });
    const second = new PortRuntime(() => failure("error", "must not be called"));
    const budget = new Budget({ lifetime: 10 });
    const result = await run(second, one(), ARGS, { cache, budget });
    expect(second.calls).toEqual([]);
    expect(result.outputs.fetch).toEqual({ ok: true, ...PAGE });
    expect(result.faults).toEqual([]);
    expect(result.tokensIn).toBe(0);
    expect(budget.lifetimeRemaining).toBe(10);
  });

  it("another value for an arg is another cell: the tool is called again", async () => {
    const cache = new MemoryWorkflowCache();
    const runtime = new PortRuntime(() => envelope(PAGE));
    await run(runtime, one(), ARGS, { cache });
    await run(runtime, one(), { url: "https://b.test/other" }, { cache });
    expect(runtime.calls.map((request) => request.args.url)).toEqual([
      "https://a.test/page",
      "https://b.test/other",
    ]);
  });

  it("another tool is another cell", async () => {
    const cache = new MemoryWorkflowCache();
    const runtime = new PortRuntime();
    await run(runtime, one({ tool: "read_file", args: { path: "a" } }), {}, { cache });
    await run(runtime, one({ tool: "web_fetch", args: { path: "a" } }), {}, { cache });
    expect(runtime.calls.map((request) => request.name)).toEqual(["read_file", "web_fetch"]);
  });

  it("`timeout` and `retries` are not part of the cell, so tightening them still replays", async () => {
    const cache = new MemoryWorkflowCache();
    const runtime = new PortRuntime();
    await run(runtime, one({ timeout: 10, retries: 0 }), ARGS, { cache });
    await run(runtime, one({ timeout: 90, retries: 3 }), ARGS, { cache });
    expect(runtime.calls).toHaveLength(1);
  });

  it("a call that failed leaves no cell, so the next run calls again", async () => {
    const cache = new MemoryWorkflowCache();
    const failing = new PortRuntime(() => failure("error", "boom"));
    await run(failing, one(), ARGS, { cache });
    const working = new PortRuntime(() => envelope(PAGE));
    const result = await run(working, one(), ARGS, { cache });
    expect(working.calls).toHaveLength(1);
    expect(result.outputs.fetch).toEqual({ ok: true, ...PAGE });
  });

  it("replays a cell without needing the port at all", async () => {
    const cache = new MemoryWorkflowCache();
    await run(new PortRuntime(), one(), ARGS, { cache });
    const result = await run(new PortlessRuntime(), one(), ARGS, { cache });
    expect(result.engineFaults).toBe(0);
    expect(result.outputs.fetch).toEqual({ ok: true });
  });
});

describe("a runtime that cannot call is an engine fault, never a silent skip (#982)", () => {
  it("a runtime without the port names the missing member", async () => {
    const result = await run(new PortlessRuntime(), one(), ARGS);
    expect(result.engineFaults).toBe(1);
    expect(result.outputs.fetch).toBeNull();
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]).toMatch(/^fetch: engine fault: .*callTool/u);
  });

  it("a port that throws is an engine fault with its message, and is not retried", async () => {
    const runtime = new PortRuntime(() => {
      throw new Error("the port broke");
    });
    const result = await run(runtime, one({ retries: 3 }), ARGS);
    expect(runtime.calls).toHaveLength(1);
    expect(result.engineFaults).toBe(1);
    expect(result.faults).toEqual(["fetch: engine fault: Error: the port broke"]);
  });

  it.each([
    ["a tool outside the allow-list", { tool: "terminal", args: {} }],
    ["no tool", { args: {} }],
    ["args that are not an object", { tool: "read_file", args: ["a"] }],
  ])(
    "a node that validateCall would have refused (%s) is an engine fault, with no call",
    async (_label, fields) => {
      const runtime = new PortRuntime();
      const workflow = new WorkflowSpec({
        meta: { name: NAME },
        inputs: {},
        schemas: {},
        nodes: [new Node("fetch", "call", fields)],
      });
      const result = await run(runtime, workflow);
      expect(runtime.calls).toEqual([]);
      expect(result.engineFaults).toBe(1);
      expect(result.faults[0]).toMatch(/^fetch: engine fault: .*validateCall/u);
    },
  );
});

describe("the engine waits for the port (#982)", () => {
  it("does not finish the run before a late call settles, and keeps its result", async () => {
    const order: string[] = [];
    const runtime = new PortRuntime(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      order.push("port settled");
      return envelope(PAGE);
    });
    const result = await run(runtime, one(), ARGS);
    order.push("run finished");
    expect(order).toEqual(["port settled", "run finished"]);
    expect(result.outputs.fetch).toEqual({ ok: true, ...PAGE });
  });

  it("holds a timer with a ref while the call is pending, because the port's own deadline has none", async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const made: { timer: ReturnType<typeof setTimeout>; ms: number | undefined }[] = [];
    const cleared: unknown[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
    ): ReturnType<typeof setTimeout> => {
      const timer = realSet(handler, ms);
      made.push({ timer, ms });
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
      timer: ReturnType<typeof setTimeout>,
    ) => {
      cleared.push(timer);
      realClear(timer);
    }) as typeof clearTimeout);
    let held: typeof made = [];
    const runtime = new PortRuntime(async () => {
      held = made.filter((entry) => (entry.ms ?? 0) >= 90_000 && entry.timer.hasRef());
      await new Promise<void>((resolve) => realSet(resolve, 5));
      return envelope(PAGE);
    });
    await run(runtime, one({ timeout: 90 }), ARGS);
    expect(held.length).toBeGreaterThanOrEqual(1);
    for (const entry of held) expect(cleared).toContain(entry.timer);
  });

  it("releases that timer when the call throws as well", async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const made: ReturnType<typeof setTimeout>[] = [];
    const cleared: unknown[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
    ): ReturnType<typeof setTimeout> => {
      const timer = realSet(handler, ms);
      if ((ms ?? 0) >= 90_000) made.push(timer);
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
      timer: ReturnType<typeof setTimeout>,
    ) => {
      cleared.push(timer);
      realClear(timer);
    }) as typeof clearTimeout);
    const runtime = new PortRuntime(() => {
      throw new Error("the port broke");
    });
    await run(runtime, one({ timeout: 90 }), ARGS);
    expect(made.length).toBeGreaterThanOrEqual(1);
    for (const timer of made) expect(cleared).toContain(timer);
  });
});
