// Issue #426 (M10-S5, épico #421): molde `tests/workflow-fault-kinds.test.ts`
// (mesmo `FakeRuntime`). Hoje (base) um leaf recusado por
// auth_failed/route_fault/model_not_found nunca pausa o run — só entra em
// `faults`/`faultKinds` e o run termina `degraded` (ou `failed`, para um
// único nó). Depois desta issue, esses três kinds pausam o run com
// `pause_reason: route_fault` e uma lição estruturada, sem entrar em
// `faultKinds` (emenda do orquestrador 2026-09-12, mesma regra que
// `quota_exhausted` já tinha); `quota_exhausted` continua no caminho antigo,
// inalterado (contra-asserção).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import type { PublicNotice } from "../src/state/index.js";
import { SqliteWorkflowCache } from "../src/workflow/sqlite-cache.js";
import { durableFromRow, durableRollup, WorkflowService } from "../src/workflow/service.js";
import {
  WorkflowEngine,
  validateSpec,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
} from "../src/workflow/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

/** One leaf per spawn, scripted collect() results, in call order — same
 * molde as `tests/workflow-fault-kinds.test.ts`'s `FakeRuntime`. */
class FakeRuntime implements ChildRuntime {
  private readonly byId = new Map<string, ChildResult[]>();
  private readonly scripts: ChildResult[][];

  constructor(scripts: ChildResult[][]) {
    this.scripts = scripts.map((script) => [...script]);
  }

  spawn(request: ChildSpawnRequest): string {
    void request;
    const id = `leaf-${String(this.byId.size + 1)}`;
    this.byId.set(id, this.scripts.shift() ?? []);
    return id;
  }

  collect(id: string, _options: ChildCollectOptions): ChildResult {
    const script = this.byId.get(id) ?? [];
    return script.shift() ?? { status: "failed", output: "script exhausted" };
  }

  steer(): void {}
  cancel(): void {}

  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

describe("route faults — engine pauses instead of degrading (#426 AC1)", () => {
  it.each(["auth_failed", "route_fault", "model_not_found"] as const)(
    "a lone leaf refused by %s pauses the run with a structured lesson",
    async (kind) => {
      const runtime = new FakeRuntime([
        [
          {
            status: "failed",
            output: "boom",
            errorKind: kind,
            retryAfter: null,
            provider: "openai",
            model: "gpt",
          },
        ],
      ]);
      const spec = parsed({
        meta: { name: "route-fail" },
        nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
      });
      const result = await new WorkflowEngine({ runtime }).run(spec);
      expect(result.status).toBe("paused");
      expect(result.pauseReason).toBe("route_fault");
      expect(result.checkpoint).toEqual({
        error_kind: kind,
        node_id: "a",
        provider: "openai",
        model: "gpt",
        suggested_route: null,
      });
      // Emenda 2026-09-12: a leaf whose kind PAUSES the run is re-executed
      // on resume — it must never leak into faultKinds (would double-count).
      expect(result.faultKinds).toEqual([]);
    },
  );

  it("quota_exhausted keeps its own pre-existing pause path, unaffected by route faults", async () => {
    const runtime = new FakeRuntime([
      [{ status: "failed", output: "429", errorKind: "quota_exhausted", retryAfter: null }],
    ]);
    const spec = parsed({
      meta: { name: "quota-only" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("quota_exhausted");
    expect(result.faultKinds).toEqual([]);
  });

  it("a non-route, non-quota kind still only records a plain fault (never pauses)", async () => {
    const runtime = new FakeRuntime([
      [{ status: "failed", output: "boom", errorKind: "unknown", retryAfter: null }],
    ]);
    const spec = parsed({
      meta: { name: "unknown-fault" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.status).toBe("failed");
    expect(result.pauseReason).toBeNull();
    expect(result.faultKinds).toEqual(["unknown"]);
    expect(result.faults).toEqual(["a: leaf failed (unknown): boom"]);
  });

  it("first node to pause wins — no priority between a route fault and a quota exhaustion in the same run", async () => {
    // Node "a" (route) spawns/collects before node "b" (quota) in this
    // FakeRuntime's deterministic call order — engine.ts:193's plain
    // `if (this.control.paused) return;` latches "a"'s pause first.
    const runtime = new FakeRuntime([
      [{ status: "failed", output: "401", errorKind: "auth_failed", retryAfter: null }],
      [{ status: "failed", output: "429", errorKind: "quota_exhausted", retryAfter: null }],
    ]);
    const spec = parsed({
      meta: { name: "route-and-quota" },
      nodes: [
        { id: "a", type: "agent", prompt: "x", retries: 0 },
        { id: "b", type: "agent", prompt: "y", retries: 0 },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.pauseReason).toBe("route_fault");
    expect(result.faultKinds).toEqual([]);
  });
});

describe("route faults — durable workflow_status exposes pause_reason and lesson (#426 AC durable)", () => {
  function harness(noticesRepository?: {
    append: (
      scope: string,
      input: { kind: string; message: string },
      ownership?: unknown,
    ) => PublicNotice | null;
  }) {
    const root = mkdtempSync(join(tmpdir(), "lohra-route-faults-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
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
      ...(noticesRepository === undefined ? {} : { notices: noticesRepository }),
    };
    const cacheFactory = (runId: string): SqliteWorkflowCache =>
      new SqliteWorkflowCache(connection.database, runId, () => ({
        fence: ownership.fence,
        holder: ownership.holder,
        now: ownership.now,
      }));
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
    const service = new WorkflowService({ runtime, store, cacheFactory });
    return {
      service,
      repository,
      close: () => {
        connection.close();
      },
    };
  }

  it("workflow_status durable rollup exposes pause_reason: route_fault and the lesson", async () => {
    const { service, repository, close } = harness();
    const started = service.start({
      meta: { name: "route-durable" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true);
    const line = repository.getRunState(started.run_id) as Record<string, unknown>;
    const view = durableFromRow(line);
    expect(view.pause_reason).toBe("route_fault");
    const rollup = durableRollup(view, 0, false);
    expect(rollup.reason).toBe("route_fault");
    expect(rollup.lesson).toEqual({
      error_kind: "auth_failed",
      node_id: "a",
      provider: null,
      model: null,
      suggested_route: null,
    });
    close();
  });

  it("records a durable notice with kind = error_kind, scoped to the run", async () => {
    const notices: Array<{ scope: string; kind: string; message: string }> = [];
    const { service, close } = harness({
      append: (scope, input) => {
        notices.push({ scope, kind: input.kind, message: input.message });
        return {
          id: 1,
          scope,
          kind: input.kind,
          message: input.message,
        } as unknown as PublicNotice;
      },
    });
    const started = service.start({
      meta: { name: "route-notice" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.scope).toBe(`run:${started.run_id}`);
    expect(notices[0]?.kind).toBe("auth_failed");
    close();
  });

  it("falls back to the plain warn sink when no notices repository was wired (never silent)", async () => {
    const warnings: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "lohra-route-faults-warn-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
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
    const cacheFactory = (runId: string): SqliteWorkflowCache =>
      new SqliteWorkflowCache(connection.database, runId, () => ({
        fence: ownership.fence,
        holder: ownership.holder,
        now: ownership.now,
      }));
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
    const service = new WorkflowService({
      runtime,
      store,
      cacheFactory,
      onWarning: (message) => warnings.push(message),
    });
    const started = service.start({
      meta: { name: "route-no-notices" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true);
    expect(warnings.some((message) => message.includes("route fault"))).toBe(true);
    connection.close();
  });
});

describe("route-faults.ts — the module's own exports (#426)", () => {
  it("isRouteFault is true only for the three route kinds, never quota_exhausted or others", async () => {
    const { isRouteFault } = await import("../src/workflow/route-faults.js");
    expect(isRouteFault("auth_failed")).toBe(true);
    expect(isRouteFault("route_fault")).toBe(true);
    expect(isRouteFault("model_not_found")).toBe(true);
    expect(isRouteFault("quota_exhausted")).toBe(false);
    expect(isRouteFault("unknown")).toBe(false);
    expect(isRouteFault(null)).toBe(false);
    expect(isRouteFault(undefined)).toBe(false);
  });

  it("pausesRun is true for quota_exhausted and the three route kinds, false otherwise", async () => {
    const { pausesRun } = await import("../src/workflow/route-faults.js");
    expect(pausesRun("quota_exhausted")).toBe(true);
    expect(pausesRun("auth_failed")).toBe(true);
    expect(pausesRun("route_fault")).toBe(true);
    expect(pausesRun("model_not_found")).toBe(true);
    expect(pausesRun("sandbox_denied")).toBe(false);
    expect(pausesRun(null)).toBe(false);
  });

  it("routeLesson prefers the leaf's own provider/model over the node's routing", async () => {
    const { routeLesson } = await import("../src/workflow/route-faults.js");
    const lesson = routeLesson(
      {
        status: "failed",
        output: "x",
        errorKind: "auth_failed",
        provider: "codex",
        model: "gpt-5",
      },
      "a",
      { provider: "openrouter", model: "other" },
    );
    expect(lesson).toEqual({
      error_kind: "auth_failed",
      node_id: "a",
      provider: "codex",
      model: "gpt-5",
      suggested_route: null,
    });
  });

  it("routeLesson falls back to the node's routing when the leaf carries no provider/model", async () => {
    const { routeLesson } = await import("../src/workflow/route-faults.js");
    const lesson = routeLesson({ status: "failed", output: "x", errorKind: "route_fault" }, "b", {
      provider: "openrouter",
      model: "other",
    });
    expect(lesson.provider).toBe("openrouter");
    expect(lesson.model).toBe("other");
  });

  it("routeFaultNotice's kind is the lesson's own error_kind, never reclassified", async () => {
    const { routeFaultNotice } = await import("../src/workflow/route-faults.js");
    const notice = routeFaultNotice({
      error_kind: "model_not_found",
      node_id: "a",
      provider: "openai",
      model: "gpt-9",
      suggested_route: null,
    });
    expect(notice.kind).toBe("model_not_found");
    expect(notice.message).toContain("model_not_found");
    expect(notice.message).toContain("a");
  });
});
