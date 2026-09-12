// Issue #459 (M11-S1, épico #458): `src/workflow/routes.ts` é um módulo
// NOVO — ausente em `origin/main` — então todo símbolo de lá é lido DENTRO
// de cada `it()` via `await import(...)` (nunca um import estático no topo
// do arquivo, molde `tests/transport-error-kinds.test.ts:7-19`): na base, o
// import falha ao resolver o módulo, o que vira uma ASSERÇÃO reprovada
// dentro do `it` (o teste roda e falha), nunca uma falha de COLETA do
// arquivo inteiro — é isso que faz `controle-negativo` classificar
// `assertion-red`, não `structural-red`.
//
// `route-faults.ts` já existe na base (#449/PR #454), mas `withSuggestedRoute`
// é um export NOVO desta issue — um `import { withSuggestedRoute } from
// "../src/workflow/route-faults.js"` estático arriscaria um erro de LINK do
// ESM (binding inexistente) em vez de uma asserção; um `import * as
// routeFaults from "..."` (namespace, seguro porque o módulo em si já
// existe na base) com `routeFaults.withSuggestedRoute` referenciado DENTRO
// do `it` é o mesmo padrão do precedente.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as routeFaults from "../src/workflow/route-faults.js";
import {
  openStateDatabase,
  WorkflowRepository,
  LockRepository,
  NoticesRepository,
} from "../src/state/index.js";
import { productionOwnershipStore } from "../src/workflow/ownership-store.js";
import { durableFromRow, durableRollup, WorkflowService } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime } from "../src/workflow/runtime.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "lohra-routes-test-"));
  roots.push(path);
  return path;
}
function routesPath(home: string): string {
  return join(home, "workflow_routes.json");
}
function validSpec(): Record<string, unknown> {
  return {
    meta: { name: "routes-fail-closed" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}
function neverRuntime(): ChildRuntime {
  return {
    spawn(): string {
      throw new Error("spawn must not be reached when routes are invalid");
    },
    collect(): ChildResult {
      throw new Error("collect must not be reached when routes are invalid");
    },
    steer(): void {
      return undefined;
    },
    cancel(): void {
      return undefined;
    },
  };
}

/** One leaf per spawn, scripted collect() results, in call order — molde
 * `FakeRuntime` (`tests/workflow-route-faults.test.ts`), needed here to
 * script TWO stretches of the SAME run (a failing pivot, then a fresh
 * fault) — a single-shot `collect()` can't tell those apart. */
class ScriptedRuntime implements ChildRuntime {
  private readonly byId = new Map<string, ChildResult[]>();
  private readonly scripts: ChildResult[][];
  private spawnCount = 0;

  constructor(scripts: ChildResult[][]) {
    this.scripts = scripts.map((script) => [...script]);
  }

  spawn(): string {
    this.spawnCount += 1;
    const id = `leaf-${String(this.spawnCount)}`;
    this.byId.set(id, this.scripts.shift() ?? []);
    return id;
  }

  collect(id: string): ChildResult {
    const script = this.byId.get(id) ?? [];
    return script.shift() ?? { status: "failed", output: "script exhausted" };
  }

  steer(): void {}
  cancel(): void {}

  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

describe("readRoutes — fail-closed (#459)", () => {
  it("returns {routes: {}} when the file is absent (legitimate)", async () => {
    const { readRoutes } = await import("../src/workflow/routes.js");
    expect(readRoutes(routesPath(root()))).toEqual({ routes: {} });
  });

  it("returns a RoutesError, not {routes: {}}, for invalid JSON", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(path, "[");
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
    expect((result as InstanceType<typeof RoutesError>).path).toBe(path);
    expect((result as InstanceType<typeof RoutesError>).message).toContain(path);
  });

  it("returns a RoutesError for a non-object root", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(path, JSON.stringify(["openrouter/x"]));
    expect(readRoutes(path)).toBeInstanceOf(RoutesError);
  });

  it("returns a RoutesError for a top-level key other than 'routes'", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(path, JSON.stringify({ route: {} }));
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
    expect((result as InstanceType<typeof RoutesError>).message).toContain("route");
  });

  it.each(["no-slash-at-all", "too/many/slashes"])(
    "returns a RoutesError for a route key without exactly one '/' (%s)",
    async (key) => {
      const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
      const path = routesPath(root());
      writeFileSync(path, JSON.stringify({ routes: { [key]: [{ provider: "p", model: "m" }] } }));
      const result = readRoutes(path);
      expect(result).toBeInstanceOf(RoutesError);
      expect((result as InstanceType<typeof RoutesError>).message).toContain(key);
    },
  );

  it("returns a RoutesError when a fallback is missing 'provider'", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(path, JSON.stringify({ routes: { "openrouter/x": [{ model: "y" }] } }));
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
    expect((result as InstanceType<typeof RoutesError>).message).toContain("provider");
  });

  it("returns a RoutesError when a fallback is missing 'model'", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(
      path,
      JSON.stringify({ routes: { "openrouter/x": [{ provider: "anthropic" }] } }),
    );
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
    expect((result as InstanceType<typeof RoutesError>).message).toContain("model");
  });

  it("returns a RoutesError when a fallback has an unknown field", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(
      path,
      JSON.stringify({ routes: { "openrouter/x": [{ provider: "a", model: "y", channel: "z" }] } }),
    );
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
    expect((result as InstanceType<typeof RoutesError>).message).toContain("channel");
  });

  it("returns a RoutesError when a fallback repeats the dead route itself", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(
      path,
      JSON.stringify({ routes: { "openrouter/x": [{ provider: "openrouter", model: "x" }] } }),
    );
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
  });

  it("returns a RoutesError for an empty fallback list", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(path, JSON.stringify({ routes: { "openrouter/x": [] } }));
    expect(readRoutes(path)).toBeInstanceOf(RoutesError);
  });

  it("returns a RoutesError for a fallback that isn't an object", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(path, JSON.stringify({ routes: { "openrouter/x": ["anthropic/y"] } }));
    expect(readRoutes(path)).toBeInstanceOf(RoutesError);
  });

  it("returns a RoutesError when 'routes' itself is an array, not an object", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(path, JSON.stringify({ routes: [] }));
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
    expect((result as InstanceType<typeof RoutesError>).message).toContain("array");
  });

  it("returns a RoutesError when a fallback's 'provider' is whitespace-only", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(
      path,
      JSON.stringify({ routes: { "openrouter/x": [{ provider: "   ", model: "y" }] } }),
    );
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
    expect((result as InstanceType<typeof RoutesError>).message).toContain("provider");
  });

  it("returns a RoutesError when a fallback's 'model' is whitespace-only", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(
      path,
      JSON.stringify({ routes: { "openrouter/x": [{ provider: "anthropic", model: "\t\n " }] } }),
    );
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
    expect((result as InstanceType<typeof RoutesError>).message).toContain("model");
  });

  it("trims a fallback's provider/model before storing (never a padded value that can't ever match)", async () => {
    const { readRoutes } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(
      path,
      JSON.stringify({ routes: { "openrouter/x": [{ provider: " anthropic ", model: " y " }] } }),
    );
    expect(readRoutes(path)).toEqual({
      routes: { "openrouter/x": [{ provider: "anthropic", model: "y" }] },
    });
  });

  it("returns a RoutesError when the path cannot be read for a reason other than absence", async () => {
    const { readRoutes, RoutesError } = await import("../src/workflow/routes.js");
    const home = root();
    const path = routesPath(home);
    mkdirSync(path);
    const result = readRoutes(path);
    expect(result).toBeInstanceOf(RoutesError);
    expect((result as InstanceType<typeof RoutesError>).message).toContain("could not be read");
  });

  it("accepts a fully-formed valid envelope, ordered fallback list preserved", async () => {
    const { readRoutes } = await import("../src/workflow/routes.js");
    const path = routesPath(root());
    writeFileSync(
      path,
      JSON.stringify({
        routes: {
          "openrouter/x": [
            { provider: "anthropic", model: "y" },
            { provider: "openai", model: "z" },
          ],
        },
      }),
    );
    expect(readRoutes(path)).toEqual({
      routes: {
        "openrouter/x": [
          { provider: "anthropic", model: "y" },
          { provider: "openai", model: "z" },
        ],
      },
    });
  });
});

describe("suggestRoute — pure (#459)", () => {
  it("returns null when the lesson has no provider or no model", async () => {
    const { suggestRoute } = await import("../src/workflow/routes.js");
    const envelope = { routes: { "openrouter/x": [{ provider: "anthropic", model: "y" }] } };
    expect(suggestRoute({ provider: null, model: "x" }, envelope, [])).toBeNull();
    expect(suggestRoute({ provider: "openrouter", model: null }, envelope, [])).toBeNull();
  });

  it("returns null when the envelope has no entry for the dead route", async () => {
    const { suggestRoute } = await import("../src/workflow/routes.js");
    const envelope = { routes: { "openrouter/x": [{ provider: "anthropic", model: "y" }] } };
    expect(suggestRoute({ provider: "openai", model: "gpt" }, envelope, [])).toBeNull();
  });

  it("returns the first fallback when none was tried yet", async () => {
    const { suggestRoute } = await import("../src/workflow/routes.js");
    const envelope = {
      routes: {
        "openrouter/x": [
          { provider: "anthropic", model: "y" },
          { provider: "openai", model: "z" },
        ],
      },
    };
    expect(suggestRoute({ provider: "openrouter", model: "x" }, envelope, [])).toEqual({
      provider: "anthropic",
      model: "y",
    });
  });

  it("skips a fallback already in 'tried', returns the next one", async () => {
    const { suggestRoute } = await import("../src/workflow/routes.js");
    const envelope = {
      routes: {
        "openrouter/x": [
          { provider: "anthropic", model: "y" },
          { provider: "openai", model: "z" },
        ],
      },
    };
    expect(
      suggestRoute({ provider: "openrouter", model: "x" }, envelope, [
        { provider: "anthropic", model: "y" },
      ]),
    ).toEqual({ provider: "openai", model: "z" });
  });

  it("returns null once every fallback was already tried", async () => {
    const { suggestRoute } = await import("../src/workflow/routes.js");
    const envelope = { routes: { "openrouter/x": [{ provider: "anthropic", model: "y" }] } };
    expect(
      suggestRoute({ provider: "openrouter", model: "x" }, envelope, [
        { provider: "anthropic", model: "y" },
      ]),
    ).toBeNull();
  });
});

describe("WorkflowService.start — refuses a broken workflow_routes.json (#459)", () => {
  it("returns a named {error} instead of launching, and never spawns a leaf", () => {
    const home = root();
    writeFileSync(routesPath(home), "[");
    const service = new WorkflowService({ runtime: neverRuntime(), homeRoot: home });
    const result = service.start(validSpec());
    expect(result).toMatchObject({ error: expect.stringContaining(routesPath(home)) as unknown });
    expect(result).not.toHaveProperty("run_id");
  });

  it("launches normally when the routes file is absent — byte-identical to before this issue", () => {
    const home = root();
    const runtime = {
      spawn: (): string => "leaf-1",
      collect: (): ChildResult => ({
        status: "complete",
        output: { answer: "ok" },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      }),
      steer: (): void => undefined,
      cancel: (): void => undefined,
    };
    const service = new WorkflowService({ runtime, homeRoot: home });
    const result = service.start(validSpec());
    expect(result).toHaveProperty("run_id");
  });
});

describe("route-faults.ts — isRouteLesson accepts both suggested_route shapes (#459)", () => {
  it("accepts suggested_route: null (unchanged)", () => {
    expect(
      routeFaults.isRouteLesson({
        error_kind: "auth_failed",
        node_id: "a",
        provider: "openai",
        model: "gpt",
        suggested_route: null,
      }),
    ).toBe(true);
  });

  it("accepts a filled suggested_route {provider, model}", () => {
    expect(
      routeFaults.isRouteLesson({
        error_kind: "auth_failed",
        node_id: "a",
        provider: "openai",
        model: "gpt",
        suggested_route: { provider: "anthropic", model: "y" },
      }),
    ).toBe(true);
  });

  it("rejects a suggested_route that is a plain string", () => {
    expect(
      routeFaults.isRouteLesson({
        error_kind: "auth_failed",
        node_id: "a",
        provider: "openai",
        model: "gpt",
        suggested_route: "anthropic/y",
      }),
    ).toBe(false);
  });

  it("rejects a suggested_route object missing 'model'", () => {
    expect(
      routeFaults.isRouteLesson({
        error_kind: "auth_failed",
        node_id: "a",
        provider: "openai",
        model: "gpt",
        suggested_route: { provider: "anthropic" },
      }),
    ).toBe(false);
  });
});

describe("route-faults.ts — withSuggestedRoute (#459)", () => {
  async function pausedRouteFaultResult(): Promise<
    InstanceType<typeof import("../src/workflow/accounting.js").RunResult>
  > {
    const { RunResult } = await import("../src/workflow/accounting.js");
    const result = new RunResult();
    result.status = "paused";
    result.pauseReason = routeFaults.ROUTE_FAULT_REASON;
    result.checkpoint = Object.freeze({
      error_kind: "auth_failed",
      node_id: "a",
      provider: "openrouter",
      model: "x",
      suggested_route: null,
    });
    return result;
  }

  it("fills suggested_route from the envelope, excluding routes already tried", async () => {
    const { suggestRoute } = await import("../src/workflow/routes.js");
    void suggestRoute;
    const result = await pausedRouteFaultResult();
    const envelope = {
      routes: {
        "openrouter/x": [
          { provider: "anthropic", model: "y" },
          { provider: "openai", model: "z" },
        ],
      },
    };
    const updated = routeFaults.withSuggestedRoute(result, envelope, [
      { provider: "anthropic", model: "y" },
    ]);
    expect(updated.checkpoint).toEqual({
      error_kind: "auth_failed",
      node_id: "a",
      provider: "openrouter",
      model: "x",
      suggested_route: { provider: "openai", model: "z" },
    });
  });

  it("leaves suggested_route null when the envelope is undefined", async () => {
    const result = await pausedRouteFaultResult();
    const updated = routeFaults.withSuggestedRoute(result, undefined, []);
    expect((updated.checkpoint as Record<string, unknown>).suggested_route).toBeNull();
  });

  it("leaves a non-route-fault result completely untouched (contra-asserção)", async () => {
    const { RunResult } = await import("../src/workflow/accounting.js");
    const result = new RunResult();
    result.status = "paused";
    result.pauseReason = "checkpoint";
    result.checkpoint = Object.freeze({ node_id: "a", prompt: "?" });
    const envelope = { routes: { "openrouter/x": [{ provider: "anthropic", model: "y" }] } };
    const updated = routeFaults.withSuggestedRoute(result, envelope, []);
    expect(updated).toBe(result);
    expect(updated.checkpoint).toEqual({ node_id: "a", prompt: "?" });
  });

  it("routeFaultNotice's message carries 'suggested=<provider>/<model>' when the lesson has one", () => {
    const notice = routeFaults.routeFaultNotice({
      error_kind: "auth_failed",
      node_id: "a",
      provider: "openrouter",
      model: "x",
      suggested_route: { provider: "anthropic", model: "y" },
    });
    expect(notice.message).toContain("suggested=anthropic/y");
  });

  it("routeFaultNotice's message carries 'suggested=none' when there is no suggestion", () => {
    const notice = routeFaults.routeFaultNotice({
      error_kind: "auth_failed",
      node_id: "a",
      provider: "openrouter",
      model: "x",
      suggested_route: null,
    });
    expect(notice.message).toContain("suggested=none");
  });
});

describe("WorkflowService end-to-end — suggested_route reaches workflow_status, pause_payload_json, and the notice (#459)", () => {
  it("a route_fault pause with an operator envelope fills lesson.suggested_route consistently", async () => {
    const home = root();
    writeFileSync(
      routesPath(home),
      JSON.stringify({ routes: { "openrouter/x": [{ provider: "anthropic", model: "y" }] } }),
    );
    const connection = openStateDatabase(join(home, "state.db"));
    const repository = new WorkflowRepository(connection.database);
    const notices = new NoticesRepository(connection.database);
    const store = productionOwnershipStore(connection.database, { notices });
    const runtime: ChildRuntime = {
      spawn(): string {
        return "leaf-1";
      },
      collect(): ChildResult {
        return {
          status: "failed",
          output: "401",
          errorKind: "auth_failed",
          retryAfter: null,
          provider: "openrouter",
          model: "x",
        };
      },
      steer(): void {},
      cancel(): void {},
      installLeafSandbox(): { dispose: () => void } {
        return { dispose: (): void => undefined };
      },
    };
    const service = new WorkflowService({ runtime, store, homeRoot: home });
    const started = service.start({
      meta: { name: "route-envelope" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    if ("error" in started) throw new Error(started.error);
    const live = await service.status(started.run_id, true);
    if ("error" in live) throw new Error(String(live.error));
    expect((live.checkpoint as Record<string, unknown>).suggested_route).toEqual({
      provider: "anthropic",
      model: "y",
    });

    const line = repository.getRunState(started.run_id) as Record<string, unknown>;
    const view = durableFromRow(line);
    expect(view.checkpoint).toEqual({
      error_kind: "auth_failed",
      node_id: "a",
      provider: "openrouter",
      model: "x",
      suggested_route: { provider: "anthropic", model: "y" },
    });
    const rollup = durableRollup(view, 0, false);
    expect(rollup.lesson).toEqual({
      error_kind: "auth_failed",
      node_id: "a",
      provider: "openrouter",
      model: "x",
      suggested_route: { provider: "anthropic", model: "y" },
    });

    const page = notices.list({ scope: `run:${started.run_id}` });
    expect(page.notices).toHaveLength(1);
    expect(page.notices[0]?.message).toContain("suggested=anthropic/y");

    connection.close();
  });

  it("WorkflowService WITHOUT a durable store also fills the live checkpoint (ephemeral terminal, service.ts's launch())", async () => {
    const home = root();
    writeFileSync(
      routesPath(home),
      JSON.stringify({ routes: { "openrouter/x": [{ provider: "anthropic", model: "y" }] } }),
    );
    const runtime: ChildRuntime = {
      spawn(): string {
        return "leaf-1";
      },
      collect(): ChildResult {
        return {
          status: "failed",
          output: "401",
          errorKind: "auth_failed",
          retryAfter: null,
          provider: "openrouter",
          model: "x",
        };
      },
      steer(): void {},
      cancel(): void {},
      installLeafSandbox(): { dispose: () => void } {
        return { dispose: (): void => undefined };
      },
    };
    // No `store` option: exercises `launch()` (service.ts's EPHEMERAL
    // terminal, :605) — never `launchDurable()`.
    const service = new WorkflowService({ runtime, homeRoot: home });
    const started = service.start({
      meta: { name: "route-envelope-ephemeral" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    if ("error" in started) throw new Error(started.error);
    const live = await service.status(started.run_id, true);
    if ("error" in live) throw new Error(String(live.error));
    expect(live.pause_reason).toBe("route_fault");
    expect(live.checkpoint).toEqual({
      error_kind: "auth_failed",
      node_id: "a",
      provider: "openrouter",
      model: "x",
      suggested_route: { provider: "anthropic", model: "y" },
    });
  });

  it("a resumed pivot never suggests the route THIS run just tried, even for a DIFFERENT node's fault (blocking finding, PR #479 rodada 1)", async () => {
    const home = root();
    writeFileSync(
      routesPath(home),
      JSON.stringify({
        routes: {
          "openrouter/x": [
            { provider: "anthropic", model: "y" },
            { provider: "anthropic", model: "z" },
          ],
          "openai/z": [
            { provider: "anthropic", model: "y" },
            { provider: "anthropic", model: "z" },
          ],
        },
      }),
    );
    const connection = openStateDatabase(join(home, "state.db"));
    const repository = new WorkflowRepository(connection.database);
    const store = productionOwnershipStore(connection.database, {});
    // Spawn order: a (stretch 1, fails on its declared route) -> a (resumed
    // with the pivot, succeeds) -> b (no declared route, fails its own).
    const runtime = new ScriptedRuntime([
      [
        {
          status: "failed",
          output: "401",
          errorKind: "auth_failed",
          retryAfter: null,
          provider: "openrouter",
          model: "x",
        },
      ],
      [{ status: "complete", output: "ok" }],
      [
        {
          status: "failed",
          output: "401",
          errorKind: "auth_failed",
          retryAfter: null,
          provider: "openai",
          model: "z",
        },
      ],
    ]);
    const service = new WorkflowService({ runtime, store, homeRoot: home });
    const started = service.start({
      meta: { name: "route-pivot-tried" },
      nodes: [
        { id: "a", type: "agent", prompt: "x", provider: "openrouter", model: "x", retries: 0 },
        { id: "b", type: "agent", prompt: "y", depends_on: ["a"], retries: 0 },
      ],
    });
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true);
    const stretch1 = durableFromRow(
      repository.getRunState(started.run_id) as Record<string, unknown>,
    );
    expect(stretch1.pause_reason).toBe("route_fault");
    expect((stretch1.checkpoint as Record<string, unknown>).node_id).toBe("a");
    expect((stretch1.checkpoint as Record<string, unknown>).suggested_route).toEqual({
      provider: "anthropic",
      model: "y",
    });

    const resumed = service.start(
      undefined,
      {},
      { resumeRunId: started.run_id, routeOverride: { provider: "anthropic", model: "y" } },
    );
    if ("error" in resumed) throw new Error(resumed.error);
    await service.status(resumed.run_id, true);
    const stretch2 = durableFromRow(
      repository.getRunState(resumed.run_id) as Record<string, unknown>,
    );
    expect(stretch2.pause_reason).toBe("route_fault");
    const lesson2 = stretch2.checkpoint as Record<string, unknown>;
    expect(lesson2.node_id).toBe("b");
    // The bug this test pins: the pivot to anthropic/y THIS RUN already
    // spent must be excluded from ANY later suggestion, not just a's own —
    // the next fallback (anthropic/z) is what's left, never anthropic/y.
    expect(lesson2.suggested_route).toEqual({ provider: "anthropic", model: "z" });
    expect(lesson2.suggested_route).not.toEqual({ provider: "anthropic", model: "y" });
    // Same payload also carries the pivot that was actually applied.
    expect(stretch2.pivots).toEqual([{ provider: "anthropic", model: "y" }]);
    connection.close();
  });

  it("without an envelope, the pause stays byte-identical to before this issue (contra-asserção)", async () => {
    const home = root();
    const connection = openStateDatabase(join(home, "state.db"));
    const repository = new WorkflowRepository(connection.database);
    const locks = new LockRepository(connection.database);
    const ownership = { fence: 0 as number, holder: "test", now: 1000 };
    const store = {
      repository,
      locks,
      holder: "test",
      ttl: 900,
      ownershipOf: () => ownership,
      database: connection.database,
    };
    const runtime: ChildRuntime = {
      spawn(): string {
        return "leaf-1";
      },
      collect(): ChildResult {
        return { status: "failed", output: "401", errorKind: "auth_failed", retryAfter: null };
      },
      steer(): void {},
      cancel(): void {},
      installLeafSandbox(): { dispose: () => void } {
        return { dispose: (): void => undefined };
      },
    };
    const service = new WorkflowService({ runtime, store, homeRoot: home });
    const started = service.start({
      meta: { name: "route-no-envelope" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true);
    const line = repository.getRunState(started.run_id) as Record<string, unknown>;
    const view = durableFromRow(line);
    expect(view.checkpoint).toEqual({
      error_kind: "auth_failed",
      node_id: "a",
      provider: null,
      model: null,
      suggested_route: null,
    });
    connection.close();
  });
});
