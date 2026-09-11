// Issue #367: `auditedChildRuntime.installLeafSandbox` hands `inner` a
// WRAPPED installation whose `wrap` produces `tool.started`/`tool.completed`
// for every tool call a leaf makes, keyed by the SAME causal identity
// `leaf.*` (#366) already publishes. Built through `WorkflowService` (real
// sqlite-backed `AuditRepository`/`WorkflowRepository`/`AuditTrail`), same
// posture as `tests/workflow-audit-leaf.test.ts` — this file pins the
// OBSERVABLE contract, not `audit-runtime.ts`'s internals.
//
// Tests drive `installation.wrap`/`onToolSettled` DIRECTLY — the same shape
// `adaptSandboxWrap` (orchestration-runtime.ts) calls them with in
// production — instead of going through `OrchestrationCore`/
// `child-runner.ts`; that seam (subId threading into `wrapDispatch`) is
// `tests/workflow-orchestration-runtime.test.ts`'s job. Each `drive` awaits
// `trail.flush()` itself, INSIDE `collect()`, before the leaf reports
// complete — the same pre-existing async-drain-vs-lease-release race #372's
// test plan documents (audit writes enqueued as a stretch finishes can lose
// the fence the instant `finishStretch()` releases it); flushing while the
// stretch still holds the lease is what a REAL sandbox wrap never needs to
// do (it never enqueues writes on the leaf's own critical path), so this is
// a test-harness accommodation, not a change to the contract under test.
// RED on main `1db43784`: zero `tool.*` events ever reach the ledger (no
// producer wires tool auditing at all).
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
import type {
  ChildResult,
  ChildRuntime,
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

/** Captures the installation `WorkflowService.launchDurable` hands over —
 * the AUDITED one, once `auditInstall`'s decorator wraps it — and lets each
 * test drive a leaf's tool calls directly through `installation.wrap`/
 * `onToolSettled` from inside `collect()`, once per leaf, before the leaf
 * reports complete. */
function capturingRuntime(
  drive: (installation: LeafSandboxInstallation, subId: string) => Promise<void>,
): ChildRuntime {
  let installation: LeafSandboxInstallation | null = null;
  let seq = 0;
  return {
    spawn: (): string => {
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect: async (id: string): Promise<ChildResult> => {
      if (installation !== null) await drive(installation, id);
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
  };
}

function spec(): Record<string, unknown> {
  return { meta: { name: "audit-tool" }, nodes: [{ id: "a", type: "agent", prompt: "one" }] };
}

/** Real sqlite-backed durable store — exactly the composition
 * `WorkflowService` sees in production. `makeRuntime` receives the `trail`
 * up front, so a test's `drive` closure can flush it itself. */
function harness(makeRuntime: (trail: AuditTrail) => ChildRuntime): {
  readonly service: WorkflowService;
  readonly repository: WorkflowRepository;
  readonly audit: AuditRepository;
  readonly close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-tool-"));
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
  const service = new WorkflowService({ runtime: makeRuntime(trail), auditTrail: trail, store });
  return {
    service,
    repository,
    audit,
    close: (): void => {
      connection.close();
    },
  };
}

function segmentIdOf(repository: WorkflowRepository, runId: string): string {
  const row = repository.getRunState(runId) as Record<string, unknown>;
  const value = row.audit_segment_id;
  expect(typeof value).toBe("string");
  return value as string;
}

describe("workflow audit — tool producers (#367)", () => {
  it('a call the sandbox lets through: tool.started then tool.completed{status:"success"} from onToolSettled; a call it denies: tool.completed{status:"error", reason:"sandbox_denied"} right after tool.started, no onToolSettled needed', async () => {
    const ref: { service: WorkflowService | null; runId: string } = { service: null, runId: "" };
    const { service, repository, audit, close } = harness((trail) =>
      capturingRuntime(async (installation, id) => {
        const owner = ref.service;
        if (owner === null) throw new Error("service not ready");
        const workingRoot = owner.workingRootFor(ref.runId);
        const base: LeafToolDispatch = (name, args) =>
          `{"ok":true,"echo":"${name}:${String(Object.keys(args).length)}"}`;
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);

        // inside the leaf's own working root — allowed regardless of
        // operator policy (sandbox.ts:fsDenial always includes workingRoot).
        const allowedOut = dispatch("read_file", { path: join(workingRoot, "note.txt") });
        expect(allowedOut).toMatch(/^\{"ok":true/);
        installation.onToolSettled?.(leaf, true);

        // outside every root — denied fail-closed before base is reached.
        const deniedOut = dispatch("write_file", { path: "/definitely/outside/every/root.txt" });
        expect(deniedOut).toMatch(/^ERROR: /);
        await trail.flush();
      }),
    );
    ref.service = service;
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      ref.runId = started.run_id;
      await service.status(started.run_id, true);
      const segmentId = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual([
        "tool.started",
        "tool.completed",
        "tool.started",
        "tool.completed",
      ]);
      for (const event of tools) {
        expect(event.identity.segment_id).toBe(segmentId);
        expect(event.identity.sub_id).toBe("leaf-1");
      }
      expect(tools[0]?.data.tool_name_state).toBe("known_tool");
      expect(tools[0]?.data.fields).toBe(1);
      expect(tools[1]?.data.status).toBe("success");
      expect(tools[1]?.data.reason).toBeUndefined();
      expect(tools[3]?.data.status).toBe("error");
      expect(tools[3]?.data.reason).toBe("sandbox_denied");
    } finally {
      close();
    }
  });

  it("a name outside the builtin catalog is classified unknown_tool and still reaches the real dispatch", async () => {
    const { service, audit, close } = harness((trail) =>
      capturingRuntime(async (installation, id) => {
        const base: LeafToolDispatch = () => '{"ok":true}';
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);
        const out = dispatch("totally_made_up_tool_37", { a: 1, b: 2 });
        expect(out).toBe('{"ok":true}');
        installation.onToolSettled?.(leaf, true);
        await trail.flush();
      }),
    );
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual(["tool.started", "tool.completed"]);
      expect(tools[0]?.data.tool_name_state).toBe("unknown_tool");
      expect(tools[0]?.data.fields).toBe(2);
      expect(tools[1]?.data.status).toBe("success");
    } finally {
      close();
    }
  });

  it("sanitization: a unicode canary in the tool name and in an argument value never reaches a tool.* payload", async () => {
    const nameCanary = "UNICODE-CANARY-\u{1F512}-TOOL-NAME";
    const argCanary = "UNICODE-CANARY-\u{1F513}-ARG-VALUE";
    const { service, audit, close } = harness((trail) =>
      capturingRuntime(async (installation, id) => {
        const base: LeafToolDispatch = () => '{"ok":true}';
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);
        dispatch(nameCanary, { secret: argCanary });
        installation.onToolSettled?.(leaf, true);
        await trail.flush();
      }),
    );
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.length).toBeGreaterThan(0);
      const rendered = JSON.stringify(tools);
      expect(rendered).not.toContain(nameCanary);
      expect(rendered).not.toContain(argCanary);
      expect(tools[0]?.data.tool_name_state).toBe("unknown_tool");
    } finally {
      close();
    }
  });

  it("fail-closed: tool.* produced after this stretch is EVICTED from the bounded fence memory never reaches the ledger — a call made BEFORE the eviction does, and a warn names the drop", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-tool-eviction-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const warnings: string[] = [];
      const running: { service: WorkflowService | null } = { service: null };
      let evicted = false;
      const runtime = capturingRuntime(async (installation, id) => {
        const base: LeafToolDispatch = () => '{"ok":true}';
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);
        dispatch("before_eviction_tool", {});
        installation.onToolSettled?.(leaf, true);
        await trail.flush();

        const owner = running.service;
        if (!evicted && owner !== null) {
          evicted = true;
          const second = owner.start(spec());
          if ("error" in second) throw new Error(second.error);
        }

        dispatch("after_eviction_tool", {});
        installation.onToolSettled?.(leaf, true);
        await trail.flush();
      });
      let n = 0;
      const service = new WorkflowService({
        runtime,
        auditTrail: trail,
        idSource: () => {
          n += 1;
          return `run-${String(n)}`;
        },
        fenceMemory: 1,
        onWarning: (message) => warnings.push(message),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      running.service = service;
      const first = service.start(spec());
      if ("error" in first) throw new Error(first.error);
      await service.status(first.run_id, true);
      expect(evicted).toBe(true);
      await trail.flush();
      const page = audit.query({ runId: first.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual(["tool.started", "tool.completed"]);
      expect(
        warnings.some((message) => message.includes("ownership lost") && message.includes("tool.")),
      ).toBe(true);
    } finally {
      connection.close();
    }
  });
});
