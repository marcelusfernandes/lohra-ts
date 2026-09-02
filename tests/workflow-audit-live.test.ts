import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/cli.js";
import { AuditRepository } from "../src/state/audit-repository.js";
import { openStateDatabase } from "../src/state/connection.js";
import {
  AUDIT_EVENT_BYTES,
  AUDIT_EVENTS_PER_RUN,
  publicAuditEvent,
  resolveAuditSettings,
  safeAuditMetadata,
} from "../src/workflow/audit-model.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowLiveEvents } from "../src/workflow/live-events.js";
import { WorkflowService } from "../src/workflow/service.js";
import type { ChildRuntime } from "../src/workflow/runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(options: ConstructorParameters<typeof AuditRepository>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "lohra-t17-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  return { root, connection, audit: new AuditRepository(connection.database, options) };
}

describe("T17 metadata-only audit", () => {
  it("redacts every private raw field without leaking a unicode canary", () => {
    const canary = "PRIVATE-🔒-秘密";
    const safe = safeAuditMetadata({
      prompt: canary,
      response: canary,
      reasoning: canary,
      content: canary,
      arguments: { secret: canary },
      result: [canary],
      provider: "provider-name",
      ignored: canary,
      metadata: { reasoning: { state: "excluded_private_state", value: canary } },
    });
    const json = JSON.stringify(safe);
    expect(json, "MUTATION_CAUSE:M1-canary-leak").not.toContain(canary);
    expect(json).not.toContain("秘密");
    expect(safe.prompt).toEqual({ state: "excluded_by_policy", characters: 12 });
    expect(safe.arguments).toEqual({ state: "excluded_by_policy", fields: 1 });
    expect(
      safeAuditMetadata({
        reasoning: { state: "excluded_by_policy", characters: 999, fields: 2 },
      }).reasoning,
    ).toEqual({ state: "excluded_by_policy", characters: 256, fields: 2 });
    expect(json).toContain("excluded_private_state");
  });

  it("persists attempt and paginates only matching audit events", () => {
    const { connection, audit } = database();
    try {
      audit.append("attempts", { event_type: "node", attempt: 1 });
      audit.append("attempts", { event_type: "node", attempt: 2 });
      audit.append("attempts", { event_type: "done", attempt: 1 });
      const page = audit.query({ runId: "attempts", attempt: 1, limit: 2 });
      expect(page.events.map((event) => [event.seq, event.identity.attempt])).toEqual([
        [1, 1],
        [3, 1],
      ]);
      expect(page.page.has_more).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("caps public events by serialized UTF-8 bytes", () => {
    const event = publicAuditEvent(
      "r",
      1,
      {
        event_type: "node.output",
        payload: {
          provider: "😀".repeat(128),
          model: "😀".repeat(128),
          node_path: Array.from({ length: 8 }, () => "😀".repeat(64)),
        },
      },
      1,
    );
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(AUDIT_EVENT_BYTES);
    expect(event.event_type, "MUTATION_CAUSE:M2-character-cap").toBe("audit.truncated");
    expect(event.data).toMatchObject({ limit_bytes: 2048, original_event_type: "node.output" });
  });

  it("bounds collection width, path width and depth exactly", () => {
    const input = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${String(i)}`, i]));
    const safe = safeAuditMetadata({
      metadata: input,
      node_path: Array.from({ length: 12 }, (_, i) => `n${String(i)}`),
      branch_path: Array.from({ length: 12 }, (_, i) => i),
      payload: { payload: { payload: { payload: { state: "deep" } } } },
    });
    expect(Object.keys(safe.metadata as object)).toHaveLength(16);
    expect(JSON.stringify(safe.metadata)).toContain('"state":"excluded_by_policy"');
    expect(safe.node_path).toEqual(["n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11"]);
    expect(safe.branch_path).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(JSON.stringify(safe)).toContain('"side":"depth"');
  });

  it("keeps audit enabled and restores the max-events default for hostile env values", () => {
    const warnings: string[] = [];
    expect(
      resolveAuditSettings({ LOHRA_AUDIT: "garbage", LOHRA_AUDIT_MAX_EVENTS: "0" }, (message) =>
        warnings.push(message),
      ),
    ).toEqual({ enabled: true, maxEventsPerRun: AUDIT_EVENTS_PER_RUN });
    expect(warnings).toHaveLength(2);
    expect(resolveAuditSettings({ LOHRA_AUDIT: "off" }).enabled).toBe(false);
    expect(resolveAuditSettings({ LOHRA_AUDIT: "no" }).enabled).toBe(false);
    expect(resolveAuditSettings({ LOHRA_AUDIT: "yes" }).enabled).toBe(true);
  });

  it("never carries arbitrary error or state prose through safe metadata", () => {
    const canary = "PRIVATE-CAUSE-🔒";
    const safe = safeAuditMetadata({
      cause: canary,
      name: canary,
      reason: canary,
      state: canary,
      status: canary,
      side: canary,
      model: "model-id",
      provider: "provider-id",
    });
    expect(JSON.stringify(safe)).not.toContain(canary);
    expect(safe).toMatchObject({
      cause: { state: "excluded_by_policy" },
      name: { state: "excluded_by_policy" },
      reason: { state: "excluded_by_policy" },
      state: { state: "excluded_by_policy" },
      status: { state: "excluded_by_policy" },
      side: { state: "excluded_by_policy" },
      model: "model-id",
      provider: "provider-id",
    });
  });

  it("applies the operator max-events environment at the SQLite boundary", () => {
    const { connection, audit } = database({ environment: { LOHRA_AUDIT_MAX_EVENTS: "2" } });
    try {
      audit.append("env-cap", { event_type: "node.started", created_at: 1 });
      audit.append("env-cap", { event_type: "node.started", created_at: 2 });
      audit.append("env-cap", { event_type: "node.started", created_at: 3 });
      expect(audit.query({ runId: "env-cap" }).events.map((event) => event.seq)).toEqual([2, 3]);
    } finally {
      connection.close();
    }
  });
});

describe("T17 SQLite audit read model", () => {
  it("allocates dense seq, freezes snapshots and keeps run-wide integrity notices", () => {
    const { connection, audit } = database({ maxEventsPerRun: 3 });
    try {
      for (let index = 1; index <= 5; index += 1)
        expect(
          audit.append("run", {
            event_type: "node",
            node_id: index % 2 ? "a" : "b",
            payload: { done: index },
            created_at: index,
          })?.seq,
        ).toBe(index);
      const frozen = audit.query({ runId: "run", snapshotSeq: 4, nodeId: "a", limit: 10 });
      expect(
        frozen.events.map((event) => event.seq),
        "MUTATION_CAUSE:M4-moving-snapshot",
      ).toEqual([3]);
      expect((frozen.integrity.notices as readonly unknown[])[0]).toEqual({
        event_type: "audit.gap",
        provenance: "dropped",
        data: { reason: "retention_limit", dropped_count: 2, before_seq: 3 },
      });
      expect(audit.query({ runId: "run", limit: 10 }).events.map((event) => event.seq)).toEqual([
        3, 4, 5,
      ]);
    } finally {
      connection.close();
    }
  });

  it("resumes a tombstoned run monotonically and compacts expired identity", () => {
    const { connection, audit } = database({ maxRuns: 1, maxTombstones: 1, retentionSeconds: 10 });
    try {
      audit.append("r1", { event_type: "node", created_at: 1 });
      audit.append("r2", { event_type: "node", created_at: 2 });
      expect(audit.append("r1", { event_type: "node", created_at: 3 })?.seq).toBe(2);
      expect(
        (audit.query({ runId: "r1" }).integrity.notices as readonly unknown[])[0],
      ).toMatchObject({ event_type: "audit.gap" });
      audit.append("fresh", { event_type: "node", created_at: 100 });
      audit.append("newer", { event_type: "node", created_at: 200 });
      expect(audit.append("r1", { event_type: "node", created_at: 200 })?.seq).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("rejects a stale fence inside the append transaction without reserving seq", () => {
    const { connection, audit } = database();
    try {
      connection.database
        .prepare("INSERT INTO workflow_run_fence(run_id,fence,updated_at) VALUES('run',2,1)")
        .run();
      connection.database
        .prepare(
          "INSERT INTO workflow_run_locks(run_id,holder,acquired_at,expires_at) VALUES('run','owner',1,100)",
        )
        .run();
      expect(
        audit.append(
          "run",
          { event_type: "node", created_at: 2 },
          { fence: 1, holder: "owner", now: 2 },
        ),
        "MUTATION_CAUSE:M6-fence-ignored",
      ).toBeNull();
      expect(
        connection.database.prepare("SELECT count(*) AS n FROM workflow_audit_events").get(),
      ).toEqual({ n: 0n });
      expect(
        audit.append(
          "run",
          { event_type: "node", created_at: 2 },
          { fence: 2, holder: "owner", now: 2 },
        )?.seq,
      ).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("rolls back sequence allocation when the event insert fails", () => {
    const { connection, audit } = database();
    try {
      connection.database.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON workflow_audit_events BEGIN SELECT RAISE(ABORT, 'planted failure'); END",
      );
      expect(() => audit.append("rollback", { event_type: "node", created_at: 1 })).toThrow(
        "planted failure",
      );
      connection.database.exec("DROP TRIGGER fail_audit");
      expect(
        audit.append("rollback", { event_type: "node", created_at: 2 })?.seq,
        "MUTATION_CAUSE:M5-nontransactional-seq",
      ).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("re-sanitizes tampered rows and exposes corruption without leaking bytes", () => {
    const { connection, audit } = database();
    try {
      audit.append("tampered", { event_type: "node.started", created_at: 1 });
      connection.database
        .prepare("UPDATE workflow_audit_events SET payload_json=? WHERE run_id='tampered'")
        .run('{"data":{"prompt":"PRIVATE-TAMPER"}}');
      const safe = audit.query({ runId: "tampered" });
      expect(JSON.stringify(safe)).not.toContain("PRIVATE-TAMPER");
      expect(safe.events[0]?.data.prompt).toEqual({
        state: "excluded_by_policy",
        characters: 14,
      });
      connection.database
        .prepare("UPDATE workflow_audit_events SET payload_json=? WHERE run_id='tampered'")
        .run("not-json");
      const corrupt = audit.query({ runId: "tampered" });
      expect(corrupt.events[0]).toMatchObject({
        event_type: "audit.unavailable",
        data: { reason: "corrupt_payload" },
      });
      expect(corrupt.integrity.event_markers).toMatchObject({ unavailable: 1 });
    } finally {
      connection.close();
    }
  });
});

describe("T17 live events and sink failures", () => {
  it("turns sanitizer exceptions into a corrupt-payload gap before enqueue", async () => {
    const { connection, audit } = database();
    try {
      const trail = new AuditTrail(audit);
      const hostile = new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("planted sanitizer failure");
          },
        },
      );
      expect(trail.record("corrupt", { event_type: "node.started", payload: hostile })).toBe(false);
      expect(await trail.flush()).toBe(true);
      expect(audit.query({ runId: "corrupt" }).events[0]).toMatchObject({
        event_type: "audit.gap",
        data: { reason: "corrupt_payload", dropped_count: 1 },
      });
    } finally {
      connection.close();
    }
  });
  it("throttles per run/node, preserves first/last, and retains a throwing observer", () => {
    let now = 10;
    const seen: string[] = [];
    let attempts = 0;
    const events = new WorkflowLiveEvents(
      (event) => {
        attempts += 1;
        if (attempts === 1) throw new Error("observer down");
        seen.push(`${event.run_id}:${event.node_id ?? "done"}:${String(event.done ?? "")}`);
      },
      () => now,
    );
    expect(events.emit({ kind: "items", run_id: "r", node_id: "a", done: 0, total: 3 })).toBe(true);
    expect(events.emit({ kind: "items", run_id: "r", node_id: "a", done: 1, total: 3 })).toBe(
      false,
    );
    expect(
      events.emit({ kind: "items", run_id: "r", node_id: "b", done: 1, total: 3 }),
      "MUTATION_CAUSE:M7-global-throttle",
    ).toBe(true);
    now += 0.1;
    expect(events.emit({ kind: "items", run_id: "r", node_id: "a", done: 3, total: 3 })).toBe(true);
    expect(events.emit({ kind: "done", run_id: "r" })).toBe(true);
    expect(attempts).toBe(4);
    expect(seen).toEqual(["r:b:1", "r:a:3", "r:done:"]);
    expect(events.trackedNodes()).toBe(0);
  });

  it("never suppresses the last item width", () => {
    const seen: number[] = [];
    const events = new WorkflowLiveEvents(
      (event) => {
        if (event.kind === "items") seen.push(event.done ?? -1);
      },
      () => 0,
    );
    expect(events.emit({ kind: "items", run_id: "r", node_id: "a", done: 0, total: 3 })).toBe(true);
    expect(events.emit({ kind: "items", run_id: "r", node_id: "a", done: 1, total: 3 })).toBe(
      false,
    );
    expect(
      events.emit({ kind: "items", run_id: "r", node_id: "a", done: 3, total: 3 }),
      "MUTATION_CAUSE:M8-last-suppressed",
    ).toBe(true);
    expect(seen).toEqual([0, 3]);
  });

  it("retries BUSY and makes shutdown failure explicit", async () => {
    let attempts = 0;
    const repo = {
      append: () => {
        attempts += 1;
        if (attempts < 3) throw new Error("database is locked");
        return {} as never;
      },
      isBusyError: (error: unknown) => error instanceof Error && /locked/.test(error.message),
    } as unknown as AuditRepository;
    const trail = new AuditTrail(repo, { retryDelayMs: 0, sleep: () => Promise.resolve() });
    expect(trail.record("r", { event_type: "node" })).toBe(true);
    expect(await trail.flush()).toBe(true);
    expect(attempts).toBe(3);

    const dead = {
      append: () => {
        throw new Error("database is locked");
      },
      isBusyError: () => true,
    } as unknown as AuditRepository;
    const warnings: string[] = [];
    const failed = new AuditTrail(dead, {
      retryDelayMs: 0,
      sleep: () => Promise.resolve(),
      warning: (message) => warnings.push(message),
    });
    failed.record("r", { event_type: "node" });
    expect(await failed.shutdown(100)).toBe(false);
    expect(warnings.join(" ")).toContain("failed");
  });

  it("settles a stale-fence refusal without poisoning the shared writer", async () => {
    const calls: string[] = [];
    const repo = {
      append: (runId: string, input: { event_type: string }, ownership?: unknown) => {
        calls.push(`${runId}:${input.event_type}`);
        return ownership === undefined ? ({} as never) : null;
      },
      isBusyError: () => false,
    } as unknown as AuditRepository;
    const warnings: string[] = [];
    const trail = new AuditTrail(repo, { warning: (message) => warnings.push(message) });
    expect(
      trail.record("stale", { event_type: "node.started" }, { fence: 1, holder: "old", now: 2 }),
    ).toBe(true);
    expect(await trail.flush()).toBe(true);
    expect(trail.record("healthy", { event_type: "node.started" })).toBe(true);
    expect(await trail.shutdown()).toBe(true);
    expect(calls, "MUTATION_CAUSE:M11-stale-refusal-poisons-writer").toEqual([
      "stale:node.started",
      "healthy:node.started",
    ]);
    expect(warnings.join(" ")).not.toContain("failed permanently");
  });

  it("turns queue overflow into an explicit gap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const inputs: string[] = [];
    const repo = {
      append: (runId: string, input: { event_type: string }) => {
        if (first) {
          first = false;
          throw new Error("database is locked");
        }
        inputs.push(`${runId}:${input.event_type}`);
        return {} as never;
      },
      isBusyError: (error: unknown) => error instanceof Error && /locked/.test(error.message),
    } as unknown as AuditRepository;
    const trail = new AuditTrail(repo, { capacity: 1, retryDelayMs: 0, sleep: () => gate });
    expect(trail.record("run-x", { event_type: "one" })).toBe(true);
    expect(trail.record("run-y", { event_type: "two" })).toBe(true);
    expect(trail.record("run-x", { event_type: "three" })).toBe(false);
    release();
    expect(await trail.flush()).toBe(true);
    expect(inputs, "MUTATION_CAUSE:M3-silent-overflow").toContain("run-x:audit.gap");
    expect(inputs).not.toContain("run-y:audit.gap");
  });

  it("audits every pipeline width even when the live surface throttles intermediates", async () => {
    const { connection, audit } = database();
    try {
      const trail = new AuditTrail(audit);
      const service = new WorkflowService({
        runtime: {
          spawn: () => "leaf",
          collect: () => ({ status: "complete", output: "ok", usage: null }),
          steer: () => undefined,
          cancel: () => undefined,
        },
        auditTrail: trail,
        idSource: () => "pipeline-audit",
      });
      service.start({
        meta: { name: "pipeline-audit" },
        nodes: [
          {
            id: "p",
            type: "pipeline",
            items: ["a", "b", "c"],
            stages: [{ prompt: "${item}" }],
          },
        ],
      });
      expect(await service.status("pipeline-audit", true)).toMatchObject({ status: "complete" });
      expect(await trail.shutdown()).toBe(true);
      const page = audit.query({ runId: "pipeline-audit", eventType: "workflow.items", limit: 20 });
      expect(page.events, "MUTATION_CAUSE:M10-throttle-drops-audit").toHaveLength(4);
    } finally {
      connection.close();
    }
  });

  it("projects a real service run into live and the metadata-only audit", async () => {
    const { connection, audit } = database();
    try {
      const trail = new AuditTrail(audit);
      const live: string[] = [];
      const runtime: ChildRuntime = {
        spawn: () => "leaf",
        collect: () => ({ status: "complete", output: "PRIVATE-OUTPUT", usage: null }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        idSource: () => "run-live",
        auditTrail: trail,
        onLiveEvent: (event) => live.push(event.kind),
      });
      expect(
        service.start({
          meta: { name: "canned" },
          nodes: [{ id: "leaf", type: "agent", prompt: "PRIVATE-PROMPT" }],
        }),
      ).toEqual({ run_id: "run-live", status: "started" });
      expect(await service.status("run-live", true)).toMatchObject({ status: "complete" });
      expect(await trail.flush()).toBe(true);
      expect(live[0]).toBe("plan");
      expect(live.at(-1)).toBe("done");
      const page = audit.query({ runId: "run-live", limit: 100 });
      expect(page.events.map((event) => event.event_type)).toEqual([
        "workflow.plan",
        "workflow.node",
        "workflow.node",
        "workflow.done",
      ]);
      expect(JSON.stringify(page)).not.toContain("PRIVATE-PROMPT");
      expect(JSON.stringify(page)).not.toContain("PRIVATE-OUTPUT");
    } finally {
      connection.close();
    }
  });

  it("honors the operator audit-off switch at the service boundary", async () => {
    const { connection, audit } = database();
    try {
      const trail = new AuditTrail(audit);
      const service = new WorkflowService({
        runtime: {
          spawn: () => "leaf",
          collect: () => ({ status: "complete", output: "ok", usage: null }),
          steer: () => undefined,
          cancel: () => undefined,
        },
        auditTrail: trail,
        environment: { LOHRA_AUDIT: "off" },
        idSource: () => "audit-disabled",
      });
      service.start({
        meta: { name: "disabled" },
        nodes: [{ id: "leaf", type: "agent", prompt: "work" }],
      });
      expect(await service.status("audit-disabled", true)).toMatchObject({ status: "complete" });
      expect(await trail.shutdown()).toBe(true);
      expect(audit.query({ runId: "audit-disabled" }).availability).toBe("unavailable");
    } finally {
      connection.close();
    }
  });
});

describe("T17 workflow CLI", () => {
  function io(root: string) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const value: CliIo = {
      environment: { HOME: root, PATH: process.env.PATH ?? "" },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    };
    return { value, stdout, stderr };
  }

  it("exposes only list/watch/audit and rejects workflow run before state effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t17-cli-"));
    roots.push(root);
    const helpIo = io(root);
    expect(await runCli(["workflow", "--help"], helpIo.value)).toBe(0);
    expect(helpIo.stdout.join("")).toContain("{list,watch,audit}");
    expect(helpIo.stdout.join("")).not.toContain("{list,watch,audit,run}");
    const badIo = io(root);
    expect(
      await runCli(["workflow", "run"], badIo.value),
      "MUTATION_CAUSE:M9-workflow-run-accepted",
    ).toBe(2);
    expect(badIo.stderr.join("")).toContain(
      "invalid choice: 'run' (choose from list, watch, audit)",
    );
  });

  it("lists an empty durable home and audits an unknown run without provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t17-cli-"));
    roots.push(root);
    const listIo = io(root);
    expect(await runCli(["workflow", "list"], listIo.value)).toBe(0);
    expect(listIo.stdout.join("")).toBe("no workflow runs\n");
    const auditIo = io(root);
    expect(await runCli(["workflow", "audit", "unknown"], auditIo.value)).toBe(0);
    expect(auditIo.stdout.join("")).toContain('"availability": "unavailable"');
    expect(readFileSync(join(root, ".lohra", "state.db")).byteLength).toBeGreaterThan(0);
  });
});
