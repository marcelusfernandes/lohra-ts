// Issue #987: `"execution": "<tier>"` em `workflow_tiers.json` — o tier que um
// nó de workflow sem `model` nem `tier` e um sub-agente de `delegate_task` sem
// `model` usam por padrão. Cobre o leitor fail-closed (`readTiers`), a
// resolução (`routingOf`), a identidade de célula (`routingIdentity` — sem a
// chave, byte-idêntica à de hoje), o motor de ponta a ponta, o runner dos
// filhos e `lohra tiers list`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClientPool } from "../src/agent/client-pool.js";
import { runTiers } from "../src/commands/tiers.js";
import { createChildRunner } from "../src/orchestration/child-runner.js";
import type { SpawnConfig } from "../src/orchestration/core.js";
import { getProviderProfile } from "../src/providers/index.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
} from "../src/transports/index.js";
import { routingIdentity, routingOf } from "../src/workflow/engine-utils.js";
import {
  MemoryWorkflowCache,
  validateSpec,
  WorkflowEngine,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
} from "../src/workflow/index.js";
import {
  executionTier,
  readTiers,
  TiersError,
  writeTiers,
  type TierMap,
} from "../src/workflow/tiers.js";
import { Node } from "../src/workflow/types.js";

const roots: string[] = [];
const closers: (() => void)[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "lohra-tier-execucao-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tiersFile(home: string, content: unknown): string {
  const path = join(home, "workflow_tiers.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const SMALL: TierMap = {
  small: { model: "x-small", provider: "p-small", effort: "low" },
  medium: { model: "x-medium" },
  big: { model: "x-big" },
  execution: "small",
};

describe("readTiers — a chave `execution` (#987)", () => {
  it("accepts `execution` naming a tier defined in the same file", () => {
    const path = tiersFile(root(), { small: { model: "m-small" }, execution: "small" });
    expect(readTiers(path)).toEqual({ small: { model: "m-small" }, execution: "small" });
  });

  it("keeps a file without the key exactly as before (no `execution` property)", () => {
    const path = tiersFile(root(), { small: "m-small" });
    const result = readTiers(path);
    expect(result).toEqual({ small: { model: "m-small" } });
    expect(Object.keys(result)).toEqual(["small"]);
  });

  it("refuses a name outside small/medium/big with a named TiersError", () => {
    const path = tiersFile(root(), { small: "m", execution: "huge" });
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    const message = (result as TiersError).message;
    expect((result as TiersError).path).toBe(path);
    expect(message).toContain("'execution' must");
    expect(message).toContain("'huge'");
    expect(message).toContain("small, medium, big");
  });

  it("refuses a tier that the file does not define", () => {
    const path = tiersFile(root(), { small: "m", execution: "medium" });
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("execution");
    expect((result as TiersError).message).toContain("'medium'");
    expect((result as TiersError).message).toContain("not defined");
  });

  it("refuses `execution` with no tier at all in the file", () => {
    const result = readTiers(tiersFile(root(), { execution: "small" }));
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("not defined");
  });

  it.each([[42], [null], [""], [["small"]], [{ tier: "small" }], [true]])(
    "refuses a non-string or empty `execution` (%j)",
    (value) => {
      const result = readTiers(tiersFile(root(), { small: "m", execution: value }));
      expect(result).toBeInstanceOf(TiersError);
      expect((result as TiersError).message).toContain("'execution' must");
    },
  );

  it("reports a broken tier before the `execution` that points at it", () => {
    const result = readTiers(tiersFile(root(), { small: {}, execution: "small" }));
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("no usable field");
  });

  it("names `execution` among the accepted keys when a top-level key is unknown", () => {
    const result = readTiers(tiersFile(root(), { foo: { model: "m" } }));
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("small, medium, big, execution");
  });

  it("round-trips through writeTiers", () => {
    const path = join(root(), "workflow_tiers.json");
    writeTiers(path, { big: { model: "b" }, execution: "big" });
    expect(readTiers(path)).toEqual({ big: { model: "b" }, execution: "big" });
  });
});

describe("executionTier", () => {
  it("is the tier that `execution` names", () => {
    expect(executionTier(SMALL)).toEqual({ model: "x-small", provider: "p-small", effort: "low" });
    expect(executionTier({ ...SMALL, execution: "big" })).toEqual({ model: "x-big" });
  });

  it("is undefined without the key, or when the named tier is not in the map", () => {
    expect(executionTier({})).toBeUndefined();
    expect(executionTier({ small: { model: "m" } })).toBeUndefined();
    expect(executionTier({ small: { model: "m" }, execution: "big" })).toBeUndefined();
  });
});

const node = (fields: Record<string, unknown>): Node => new Node("n", "agent", fields);

describe("routingOf — o padrão de execução (#987)", () => {
  it("a node with neither model nor tier takes the execution tier", () => {
    expect(routingOf(node({ prompt: "x" }), SMALL)).toEqual({
      provider: "p-small",
      model: "x-small",
      effort: "low",
    });
  });

  it("an explicit model wins, and the execution tier gives nothing else to that node", () => {
    expect(routingOf(node({ prompt: "x", model: "mine" }), SMALL)).toEqual({ model: "mine" });
  });

  it("an explicit tier wins over the execution tier", () => {
    expect(routingOf(node({ prompt: "x", tier: "big" }), SMALL)).toEqual({ model: "x-big" });
  });

  it("an explicit tier the map does not define resolves to nothing, never to the execution tier", () => {
    const tiers: TierMap = { small: { model: "x-small" }, execution: "small" };
    expect(routingOf(node({ prompt: "x", tier: "big" }), tiers)).toEqual({});
  });

  it("explicit provider and effort still beat the execution tier's, field by field", () => {
    expect(routingOf(node({ prompt: "x", provider: "mine", effort: "high" }), SMALL)).toEqual({
      provider: "mine",
      model: "x-small",
      effort: "high",
    });
  });

  it("without the key a node with neither model nor tier resolves to nothing, as before", () => {
    const tiers: TierMap = { small: { model: "x-small" }, big: { model: "x-big" } };
    expect(routingOf(node({ prompt: "x" }), tiers)).toEqual({});
    expect(routingOf(node({ prompt: "x" }), {})).toEqual({});
  });
});

describe("routingIdentity — identidade de célula (#987)", () => {
  it("without `execution` a node declaring no route keeps the identity of today: []", () => {
    expect(routingIdentity(node({ prompt: "x" }), {})).toEqual([]);
    const tiers: TierMap = { small: { model: "x-small" }, big: { model: "x-big" } };
    expect(routingIdentity(node({ prompt: "x" }), tiers)).toHaveLength(0);
    expect(routingIdentity(node({ prompt: "x" }), tiers)).toEqual([]);
  });

  it("without `execution` a node declaring a route keeps the identity of today", () => {
    const tiers: TierMap = { small: { model: "x-small", effort: "low" } };
    expect(routingIdentity(node({ prompt: "x", tier: "small" }), tiers)).toEqual([
      "x-small",
      "low",
      null,
    ]);
    expect(routingIdentity(node({ prompt: "x", model: "m", provider: "p" }), tiers)).toEqual([
      "m",
      null,
      "p",
    ]);
  });

  it("with `execution` a node with no route carries the resolved [model, effort, provider]", () => {
    expect(routingIdentity(node({ prompt: "x" }), SMALL)).toEqual(["x-small", "low", "p-small"]);
  });

  it("switching the execution tier changes the identity of the nodes without a tier", () => {
    const small = routingIdentity(node({ prompt: "x" }), SMALL);
    const big = routingIdentity(node({ prompt: "x" }), { ...SMALL, execution: "big" });
    expect(big).toEqual(["x-big", null, null]);
    expect(big).not.toEqual(small);
  });

  it("changing the model of the execution tier changes the identity too", () => {
    const moved: TierMap = { ...SMALL, small: { ...SMALL.small, model: "x-small-2" } };
    expect(routingIdentity(node({ prompt: "x" }), moved)).not.toEqual(
      routingIdentity(node({ prompt: "x" }), SMALL),
    );
  });

  it("a node with its own model or tier is unaffected by the execution tier", () => {
    const other: TierMap = { ...SMALL, execution: "big" };
    for (const fields of [
      { prompt: "x", model: "mine" },
      { prompt: "x", tier: "medium" },
    ]) {
      expect(routingIdentity(node(fields), SMALL)).toEqual(routingIdentity(node(fields), other));
    }
  });

  it("a route-less node under `execution: small` has the identity of a node naming tier small", () => {
    expect(routingIdentity(node({ prompt: "x" }), SMALL)).toEqual(
      routingIdentity(node({ prompt: "x", tier: "small" }), SMALL),
    );
  });

  it("a node naming only effort or provider also takes the resolved model into the identity", () => {
    expect(routingIdentity(node({ prompt: "x", effort: "high" }), SMALL)).toEqual([
      "x-small",
      "high",
      "p-small",
    ]);
  });
});

class RecordingRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  spawn(request: ChildSpawnRequest): string {
    this.spawned.push(request);
    return `leaf-${String(this.spawned.length)}`;
  }
  collect(): ChildResult {
    return { status: "complete", output: { ok: true } };
  }
  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

/** Cada tipo de nó que gera leaf, com o nó sem model/tier e o equivalente com `tier: "big"`
 * onde o tipo aceita roteamento (`parallel` não aceita: `branches` nunca tem tier). */
const NODES: readonly (readonly [
  string,
  Record<string, unknown>,
  Record<string, unknown> | null,
])[] = [
  [
    "agent",
    { id: "n", type: "agent", prompt: "x" },
    { id: "n", type: "agent", prompt: "x", tier: "big" },
  ],
  ["parallel", { id: "n", type: "parallel", branches: ["x", "y"] }, null],
  [
    "pipeline",
    { id: "n", type: "pipeline", items: ["a"], stages: [{ prompt: "${item}" }] },
    { id: "n", type: "pipeline", items: ["a"], stages: [{ prompt: "${item}", tier: "big" }] },
  ],
  [
    "gate",
    { id: "n", type: "gate", body: { prompt: "x" }, validator: "review", attempts: 1 },
    {
      id: "n",
      type: "gate",
      body: { prompt: "x" },
      validator: "review",
      attempts: 1,
      tier: "big",
    },
  ],
  [
    "loop_until_dry",
    {
      id: "n",
      type: "loop_until_dry",
      body: { prompt: "r ${round}" },
      stop_after_k_empty: 1,
      max_rounds: 1,
    },
    {
      id: "n",
      type: "loop_until_dry",
      body: { prompt: "r ${round}" },
      stop_after_k_empty: 1,
      max_rounds: 1,
      tier: "big",
    },
  ],
];

async function modelsOf(node: Record<string, unknown>): Promise<readonly (string | undefined)[]> {
  const runtime = new RecordingRuntime();
  await new WorkflowEngine({ runtime, tiers: SMALL }).run(
    parsed({ meta: { name: "exec-engine" }, nodes: [node] }),
  );
  return runtime.spawned.map((request) => request.model);
}

describe("WorkflowEngine — todo tipo de nó que gera leaf usa o tier de execução (#987)", () => {
  it.each(NODES)("%s: a leaf with no model/tier runs on the execution tier", async (_t, bare) => {
    const runtime = new RecordingRuntime();
    await new WorkflowEngine({ runtime, tiers: SMALL }).run(
      parsed({ meta: { name: "exec-default" }, nodes: [bare] }),
    );
    expect(runtime.spawned.length).toBeGreaterThan(0);
    for (const request of runtime.spawned) {
      expect(request.model).toBe("x-small");
      expect(request.provider).toBe("p-small");
      expect(request.effort).toBe("low");
    }
  });

  it.each(NODES.filter(([, , tiered]) => tiered !== null))(
    "%s: an explicit tier wins over the execution tier",
    async (_t, _bare, tiered) => {
      const models = await modelsOf(tiered as Record<string, unknown>);
      expect(models.length).toBeGreaterThan(0);
      expect(models).toContain("x-big");
      expect(models).not.toContain("x-small");
    },
  );

  it("an explicit model on the node wins", async () => {
    const runtime = new RecordingRuntime();
    await new WorkflowEngine({ runtime, tiers: SMALL }).run(
      parsed({
        meta: { name: "exec-explicit-model" },
        nodes: [{ id: "n", type: "agent", prompt: "x", model: "mine" }],
      }),
    );
    expect(runtime.spawned.map((request) => request.model)).toEqual(["mine"]);
  });

  it("in a pipeline each stage resolves alone: its own tier, else the execution tier", async () => {
    const runtime = new RecordingRuntime();
    await new WorkflowEngine({ runtime, tiers: SMALL }).run(
      parsed({
        meta: { name: "exec-stage" },
        nodes: [
          {
            id: "n",
            type: "pipeline",
            items: ["a"],
            stages: [
              { prompt: "${item}" },
              { prompt: "${stage.result}", tier: "medium" },
              { prompt: "${stage.result}" },
            ],
          },
        ],
      }),
    );
    expect(runtime.spawned.map((request) => request.model)).toEqual([
      "x-small",
      "x-medium",
      "x-small",
    ]);
  });

  it("without the key the leaf carries no model, exactly as before", async () => {
    const runtime = new RecordingRuntime();
    await new WorkflowEngine({
      runtime,
      tiers: { small: { model: "x-small" }, big: { model: "x-big" } },
    }).run(parsed({ meta: { name: "no-key" }, nodes: [{ id: "n", type: "agent", prompt: "x" }] }));
    expect(runtime.spawned).toHaveLength(1);
    expect(runtime.spawned[0]?.model).toBeUndefined();
    expect(runtime.spawned[0]?.provider).toBeUndefined();
    expect(runtime.spawned[0]?.effort).toBeUndefined();
  });
});

describe("WorkflowEngine — a célula acompanha o tier de execução (#987)", () => {
  const spec = (): ReturnType<typeof parsed> =>
    parsed({ meta: { name: "exec-cell" }, nodes: [{ id: "n", type: "agent", prompt: "x" }] });

  async function spawnsWith(
    cache: MemoryWorkflowCache,
    tiers: TierMap,
  ): Promise<readonly string[]> {
    const runtime = new RecordingRuntime();
    await new WorkflowEngine({ runtime, cache, runId: "run-1", tiers }).run(spec());
    return runtime.spawned.map((request) => request.model ?? "<none>");
  }

  it("replays the cell while the execution tier is the same, and reruns when it changes", async () => {
    const cache = new MemoryWorkflowCache();
    expect(await spawnsWith(cache, SMALL)).toEqual(["x-small"]);
    expect(await spawnsWith(cache, SMALL)).toEqual([]);
    expect(await spawnsWith(cache, { ...SMALL, execution: "big" })).toEqual(["x-big"]);
    expect(await spawnsWith(cache, { ...SMALL, execution: "big" })).toEqual([]);
  });

  it("reruns when the model behind the execution tier changes", async () => {
    const cache = new MemoryWorkflowCache();
    expect(await spawnsWith(cache, SMALL)).toEqual(["x-small"]);
    expect(await spawnsWith(cache, { ...SMALL, small: { model: "x-small-2" } })).toEqual([
      "x-small-2",
    ]);
  });

  it("without the key the tier map never touches the cell of a node with no route", async () => {
    const cache = new MemoryWorkflowCache();
    expect(await spawnsWith(cache, {})).toEqual(["<none>"]);
    expect(await spawnsWith(cache, { small: { model: "x-small" } })).toEqual([]);
    expect(await spawnsWith(cache, { big: { model: "x-big" } })).toEqual([]);
  });
});

const encoder = new TextEncoder();
const noSignal = new AbortController().signal;

function assistantStream(text: string): HttpResponseData {
  const frames = [
    { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ];
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: encoder.encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")),
  };
}

class QueuePort implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
    return Promise.resolve(assistantStream("done"));
  }
  body(index = 0): { model?: string; reasoning_effort?: string } {
    return JSON.parse(this.requests[index]?.body ?? "null") as {
      model?: string;
      reasoning_effort?: string;
    };
  }
}

function childRunner(tiers: (() => TierMap | TiersError) | undefined): {
  readonly run: (config: SpawnConfig) => ReturnType<ReturnType<typeof createChildRunner>>;
  readonly port: QueuePort;
} {
  const connection = openStateDatabase(join(root(), "state.db"));
  closers.push(() => {
    connection.close();
  });
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  sessions.createSession({ id: "parent-1", source: "gateway" });
  const profile = getProviderProfile("openai");
  if (profile === null) throw new Error("openai profile missing");
  const port = new QueuePort();
  const client = new ChatCompletionsClient({
    baseUrl: "http://parent.invalid/v1",
    apiKey: "lohra-local",
    transport: new ChatCompletionsTransport(),
    http: port,
  });
  const runner = createChildRunner({
    sessions,
    parentSessionId: "parent-1",
    clientPool: new ClientPool(profile, client, { home: "/tmp", environment: {} }),
    baseDispatch: () => Promise.resolve("unused"),
    parentToolDefinitions: [],
    defaultModel: "orchestrator-model",
    cwd: "/tmp",
    idSource: () => "unused",
    clock: () => 1000,
    childMaxIterations: 50,
    ...(tiers === undefined ? {} : { tiers }),
  });
  let counter = 0;
  return {
    run: (config) => {
      counter += 1;
      return runner(`child-${String(counter)}`, config, "SYSTEM", () => [], noSignal);
    },
    port,
  };
}

describe("createChildRunner — sub-agente sem model usa o tier de execução (#987)", () => {
  it("without the `tiers` option the child runs on the orchestrator's model, as before", async () => {
    const { run, port } = childRunner(undefined);
    const result = await run({ prompt: "go" });
    expect(result.status).toBe("complete");
    expect(result.model).toBe("orchestrator-model");
    expect(port.body().model).toBe("orchestrator-model");
  });

  it("a delegated child with no model runs on the model of the execution tier", async () => {
    const { run, port } = childRunner(() => ({
      small: { model: "x-small", effort: "low" },
      execution: "small",
    }));
    const result = await run({ prompt: "go" });
    expect(result.status).toBe("complete");
    expect(result.model).toBe("x-small");
    expect(port.body().model).toBe("x-small");
    expect(port.body().reasoning_effort).toBe("low");
  });

  it("an explicit model on the task wins; so does an explicit effort", async () => {
    const { run, port } = childRunner(() => ({
      small: { model: "x-small", effort: "low" },
      execution: "small",
    }));
    const result = await run({ prompt: "go", model: "mine", effort: "high" });
    expect(result.model).toBe("mine");
    expect(port.body().model).toBe("mine");
    expect(port.body().reasoning_effort).toBe("high");
  });

  it("a map without `execution` leaves the child on the orchestrator's model", async () => {
    const { run, port } = childRunner(() => ({ small: { model: "x-small" } }));
    const result = await run({ prompt: "go" });
    expect(result.model).toBe("orchestrator-model");
    expect(port.body().model).toBe("orchestrator-model");
  });

  it("reads the file per spawn, so editing the tier takes effect without a restart", async () => {
    let current: TierMap = { small: { model: "x-small" }, execution: "small" };
    const { run, port } = childRunner(() => current);
    expect((await run({ prompt: "one" })).model).toBe("x-small");
    current = { small: { model: "x-small" }, big: { model: "x-big" }, execution: "big" };
    expect((await run({ prompt: "two" })).model).toBe("x-big");
    expect(port.requests).toHaveLength(2);
  });

  it("an unreadable tier file fails the child with the named error and never calls the model", async () => {
    const path = join(root(), "workflow_tiers.json");
    const { run, port } = childRunner(() => new TiersError(path, "is not valid JSON"));
    const result = await run({ prompt: "go" });
    expect(result.status).toBe("error");
    expect(result.output).toContain(path);
    expect(result.output).toContain("workflow_tiers.json");
    expect(port.requests).toHaveLength(0);
  });

  it("a task with an explicit model does not depend on the tier file", async () => {
    const path = join(root(), "workflow_tiers.json");
    const { run, port } = childRunner(() => new TiersError(path, "is not valid JSON"));
    const result = await run({ prompt: "go", model: "mine" });
    expect(result.status).toBe("complete");
    expect(port.body().model).toBe("mine");
  });

  it("a tier provider the pool cannot resolve fails the child by name", async () => {
    const { run, port } = childRunner(() => ({
      small: { model: "x-small", provider: "no-such-provider" },
      execution: "small",
    }));
    const result = await run({ prompt: "go" });
    expect(result.status).toBe("error");
    expect(result.output).toContain("no-such-provider");
    expect(port.requests).toHaveLength(0);
  });

  it("a workflow leaf (wrapDispatch set) is left to the engine: no model stays the orchestrator's", async () => {
    const { run, port } = childRunner(() => ({
      small: { model: "x-small" },
      execution: "small",
    }));
    const result = await run({ prompt: "go", wrapDispatch: (base) => base });
    expect(result.model).toBe("orchestrator-model");
    expect(port.body().model).toBe("orchestrator-model");
  });
});

describe("lohra tiers list — mostra o `execution` (#987)", () => {
  const list = (home: string): ReturnType<typeof runTiers> =>
    runTiers({
      action: "list",
      noInput: true,
      home,
      environment: {},
      probeOllama: () => Promise.reject(new Error("must not be called")),
    });

  it("prints the execution tier after the tiers", async () => {
    const home = root();
    tiersFile(home, { small: { provider: "openai", model: "m-small" }, execution: "small" });
    const result = await list(home);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("small: openai/m-small\nexecution: small\n");
  });

  it("prints nothing about it when the key is absent", async () => {
    const home = root();
    tiersFile(home, { small: "m-small" });
    const result = await list(home);
    expect(result.stdout).toBe("small: m-small\n");
  });

  it("exits 1 with the TiersError when `execution` names an undefined tier", async () => {
    const home = root();
    const path = tiersFile(home, { small: "m-small", execution: "big" });
    const result = await list(home);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(path);
    expect(result.stderr).toContain("execution");
  });
});
