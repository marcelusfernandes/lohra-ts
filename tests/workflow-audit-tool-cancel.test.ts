// Issue #383, items 6-7 (emenda do orquestrador, veredito da PR #385, sobre
// `src/workflow/audit-runtime.ts`'s `close()`/`onToolSettled`, mergeados em
// #385/#378): two gaps the reviewer named without a test.
//
//  6. A settle that arrives AFTER `close()` already flushed the leaf's
//     pending dispatch (cancel, shutdown, or the leaf's own timeout) must
//     NOT emit a second `tool.completed` — the guard `if (openLeaf !==
//     undefined)` (audit-runtime.ts's `onToolSettled`, ~:306-321) is what
//     makes that late settle a no-op instead of a duplicate.
//  7. `pending.count` lives on `OpenLeaf`, keyed per `sub_id` — one leaf
//     closing (its own timeout) must never touch a SIBLING leaf's still-open
//     dispatch. Two independent top-level nodes, each with one dispatch left
//     unsettled, prove the counter is per-leaf, not a single shared one.
//
// Molded on `tests/workflow-audit-tool.test.ts`'s harness (real sqlite-
// backed `WorkflowRepository`/`AuditRepository`/`AuditTrail`,
// `gatedToolRuntime`) — duplicated here rather than imported, same
// convention as every other file in this suite; `tests/workflow-audit-tool.test.ts`
// itself is Files-frozen at 775 lines (regra `arquivo-grande`) and stays
// unedited.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type { Timer } from "../src/workflow/durability.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafIdentity,
  LeafSandboxHandle,
  LeafSandboxInstallation,
  LeafToolDispatch,
} from "../src/workflow/runtime.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const USAGE = {
  inputTokens: 3,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function spec(): Record<string, unknown> {
  return {
    meta: { name: "audit-tool-cancel" },
    nodes: [{ id: "a", type: "agent", prompt: "one" }],
  };
}

/** Two independent top-level nodes, no dependency between them — the engine
 * (`BoundedPool`, default width 4) runs both concurrently, one spawn each. */
function twoNodeSpec(): Record<string, unknown> {
  return {
    meta: { name: "audit-tool-cancel-two" },
    nodes: [
      { id: "a", type: "agent", prompt: "one" },
      { id: "b", type: "agent", prompt: "two" },
    ],
  };
}

/** Same shape as `tests/workflow-audit-tool.test.ts`'s own `harness` —
 * real sqlite-backed store, `makeRuntime` receives the `trail` up front. */
function harness(
  makeRuntime: (trail: AuditTrail) => ChildRuntime,
  options: { readonly timerFactory?: (delay: number, fire: () => void) => Timer } = {},
): {
  readonly service: WorkflowService;
  readonly repository: WorkflowRepository;
  readonly audit: AuditRepository;
  readonly trail: AuditTrail;
  readonly close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-tool-cancel-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const store: OwnershipStore = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ownership,
    database: connection.database,
  };
  const service = new WorkflowService({
    runtime: makeRuntime(trail),
    auditTrail: trail,
    store,
    ...(options.timerFactory === undefined ? {} : { timerFactory: options.timerFactory }),
  });
  return {
    service,
    repository,
    audit,
    trail,
    close: (): void => {
      connection.close();
    },
  };
}

/** Same shape as `tests/workflow-audit-tool.test.ts`'s own `gatedToolRuntime`
 * — a single leaf whose `collect()` stays pending until `release()`, while
 * capturing the AUDITED installation so a test can drive a tool dispatch
 * through it directly. */
function gatedToolRuntime(
  onCollect: (installation: LeafSandboxInstallation, subId: string) => void,
): ChildRuntime & { release(): void } {
  let openGate!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    openGate = resolveGate;
  });
  let installation: LeafSandboxInstallation | null = null;
  let driven = false;
  return {
    spawn: (): string => "leaf-1",
    collect: async (id: string): Promise<ChildResult> => {
      if (!driven && installation !== null) {
        driven = true;
        onCollect(installation, id);
      }
      await gate;
      return { status: "complete", output: { ok: true }, usage: USAGE };
    },
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (given: LeafSandboxInstallation): LeafSandboxHandle => {
      installation = given;
      return {
        dispose: () => {
          installation = null;
        },
      };
    },
    release: (): void => {
      openGate();
    },
  };
}

/** Node "a" answers `collect()` with `running` straight away — the SAME
 * shape a real leaf timeout takes (`wait:true` collect returning
 * `running`), which `audit-runtime.ts`'s own `collect()` closes
 * synchronously (no need for a real clock). Node "b" stays gated until
 * `releaseB()` — the sibling whose dispatch must stay untouched by "a"'s
 * close(). Keyed by `causalContext.nodePath`, not spawn order, since two
 * concurrent nodes race for which one's `spawn()` runs first. */
function twoNodePendingRuntime(
  onCollect: (installation: LeafSandboxInstallation, subId: string) => void,
): ChildRuntime & { releaseB(): void } {
  let installation: LeafSandboxInstallation | null = null;
  const driven = new Set<string>();
  const nodeOf = new Map<string, string>();
  let openB!: () => void;
  const gateB = new Promise<void>((resolveGate) => {
    openB = resolveGate;
  });
  let seq = 0;
  return {
    spawn: (request: ChildSpawnRequest): string => {
      seq += 1;
      const id = `leaf-${String(seq)}`;
      nodeOf.set(id, request.causalContext.nodePath.at(-1) ?? "");
      return id;
    },
    collect: async (id: string): Promise<ChildResult> => {
      if (!driven.has(id) && installation !== null) {
        driven.add(id);
        onCollect(installation, id);
      }
      if (nodeOf.get(id) === "a") return { status: "running", output: null };
      await gateB;
      return { status: "complete", output: { ok: true }, usage: USAGE };
    },
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (given: LeafSandboxInstallation): LeafSandboxHandle => {
      installation = given;
      return {
        dispose: () => {
          installation = null;
        },
      };
    },
    releaseB: (): void => {
      openB();
    },
  };
}

describe("workflow audit — tool producers, close()/onToolSettled races (#385)", () => {
  it("a settle that arrives AFTER close() (leaf cancel) does not emit a second tool.completed for the same dispatch", async () => {
    const ref: {
      service: WorkflowService | null;
      runId: string;
      installation: LeafSandboxInstallation | null;
      leaf: LeafIdentity | null;
    } = { service: null, runId: "", installation: null, leaf: null };
    const runtime = gatedToolRuntime((installation, id) => {
      const owner = ref.service;
      if (owner === null) throw new Error("service not ready");
      const workingRoot = owner.workingRootFor(ref.runId);
      const base: LeafToolDispatch = () => '{"ok":true}';
      const leaf: LeafIdentity = { subId: id };
      ref.installation = installation;
      ref.leaf = leaf;
      const dispatch = installation.wrap(base, leaf);
      dispatch("read_file", { path: join(workingRoot, "late-settle.txt") }); // never settles here
    });
    const timers: { fire(): void }[] = [];
    const timerFactory = (_delay: number, fire: () => void): Timer => {
      timers.push({ fire });
      return { cancel: (): void => undefined };
    };
    const { service, audit, trail, close } = harness(() => runtime, { timerFactory });
    ref.service = service;
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      ref.runId = started.run_id;
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      const done = Promise.resolve(service.cancel(started.run_id));
      timers[timers.length - 1]?.fire(); // the leaf is still gated — the ceiling elapses
      await done;
      await trail.flush();
      // The real dispatch settles LATE, after close() already flushed it as
      // cancelled — exactly the race the guard exists for.
      ref.installation?.onToolSettled?.(ref.leaf as LeafIdentity, true);
      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual(["tool.started", "tool.completed"]);
      expect(tools[1]?.data).toMatchObject({ status: "error", reason: "cancelled" });
      runtime.release();
    } finally {
      close();
    }
  });

  it("two leaves with an open dispatch each: pending.count is per sub_id — one leaf's close() never emits tool.completed for the sibling's still-open dispatch", async () => {
    const ref: { service: WorkflowService | null; runId: string } = { service: null, runId: "" };
    const runtime = twoNodePendingRuntime((installation, id) => {
      const owner = ref.service;
      if (owner === null) throw new Error("service not ready");
      const workingRoot = owner.workingRootFor(ref.runId);
      const base: LeafToolDispatch = () => '{"ok":true}';
      const leaf: LeafIdentity = { subId: id };
      const dispatch = installation.wrap(base, leaf);
      dispatch("read_file", { path: join(workingRoot, `${id}.txt`) }); // never settles
    });
    const { service, audit, trail, close } = harness(() => runtime);
    ref.service = service;
    try {
      const started = service.start(twoNodeSpec());
      if ("error" in started) throw new Error(started.error);
      ref.runId = started.run_id;
      // Both leaves spawn and dispatch synchronously inside `start()`'s own
      // engine kickoff; node "a"'s fake timeout close() resolves with them —
      // no real clock needed, but a couple of event-loop turns for the
      // audit trail's own microtask drain.
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 200 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      const bySubId = new Map<string, { type: string; data: unknown }[]>();
      for (const event of tools) {
        const subId = String(event.identity.sub_id);
        const list = bySubId.get(subId) ?? [];
        list.push({ type: event.event_type, data: event.data });
        bySubId.set(subId, list);
      }
      expect(bySubId.size).toBe(2);
      const sequences = [...bySubId.values()];
      const closedLeaf = sequences.find((seq) => seq.length === 2);
      const openLeaf = sequences.find((seq) => seq.length === 1);
      expect(closedLeaf?.map((entry) => entry.type)).toEqual(["tool.started", "tool.completed"]);
      expect(closedLeaf?.[1]?.data).toMatchObject({ status: "error", reason: "cancelled" });
      expect(openLeaf?.map((entry) => entry.type)).toEqual(["tool.started"]);

      runtime.releaseB();
      await service.status(started.run_id, true);
    } finally {
      close();
    }
  });
});
