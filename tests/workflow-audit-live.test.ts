import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/cli.js";
import { createChatSessionRegistry, runChat } from "../src/commands/chat.js";
import { registerProvider } from "../src/providers/registry.js";
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
import { WorkflowTool } from "../src/workflow/tool.js";

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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

describe("T17 metadata-only audit", () => {
  it("installs workflow_audit in the same session registry used by public chat", async () => {
    const { connection, audit } = database();
    try {
      audit.append("public-audit", { event_type: "node.started", created_at: 1 });
      const registry = createChatSessionRegistry(connection.database, {});
      const output = JSON.parse(
        await registry.dispatch("workflow_audit", { run_id: "public-audit" }),
      ) as {
        readonly ok: boolean;
        readonly events: readonly { readonly event_type: string }[];
      };
      expect(output.ok, "MUTATION_CAUSE:M12-public-audit-wiring").toBe(true);
      expect(output.events.map((event) => event.event_type)).toEqual(["node.started"]);
    } finally {
      connection.close();
    }
  });

  it("routes workflow_audit through the actual runChat composition root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t17-public-chat-"));
    roots.push(root);
    const state = openStateDatabase(join(root, ".lohra", "state.db"));
    new AuditRepository(state.database).append("public-audit", {
      event_type: "node.started",
      created_at: 1,
    });
    state.close();

    const requests: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push(body);
        const first = requests.length === 1;
        const payload = {
          id: `chatcmpl-t17-${String(requests.length)}`,
          object: "chat.completion",
          created: 0,
          model: "t17-audit-model",
          choices: [
            {
              index: 0,
              message: first
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-t17-audit",
                        type: "function",
                        function: {
                          name: "workflow_audit",
                          arguments: '{"run_id":"public-audit"}',
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: "audit complete" },
              finish_reason: first ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
        const text = JSON.stringify(payload);
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
        });
        response.end(text);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t17-audit-chat-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T17 audit chat probe",
        description: "Local in-memory composition-root probe.",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t17-audit-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const result = await runChat({
        input: "inspect public-audit",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t17-audit-model"],
          ["--json", true],
          ["--no-input", true],
        ]),
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
      });
      expect(result.code).toBe(0);
      expect(requests).toHaveLength(2);
      const secondMessages = requests[1]?.messages as readonly Record<string, unknown>[];
      const toolMessage = secondMessages.find((message) => message.role === "tool");
      const toolResult = JSON.parse(String(toolMessage?.content)) as {
        readonly ok: boolean;
        readonly events: readonly { readonly event_type: string }[];
      };
      expect(toolResult.ok, "MUTATION_CAUSE:M22-run-chat-public-audit-wiring").toBe(true);
      expect(toolResult.events.map((event) => event.event_type)).toEqual(["node.started"]);
    } finally {
      await closeServer(server);
    }
  });

  it("serializes fractional audit timestamps through the public workflow tool", () => {
    const { connection, audit } = database();
    audit.append("fractional", { event_type: "node.started", created_at: 1.25 });
    const runtime = {
      spawn: () => "unused",
      collect: () => ({ status: "complete", output: null, usage: null }),
      steer: () => undefined,
      cancel: () => undefined,
    } as ChildRuntime;
    const output = new WorkflowTool(new WorkflowService({ runtime }), audit).audit({
      run_id: "fractional",
    });
    const parsed = JSON.parse(output) as {
      readonly ok: boolean;
      readonly events: readonly { readonly created_at: number }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.events[0]?.created_at).toBe(1.25);
    connection.close();
  });

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
    const hostileEnvelope = publicAuditEvent(
      "run",
      1,
      { event_type: canary, provenance: canary, payload: { content: canary } },
      1,
    );
    expect(JSON.stringify(hostileEnvelope)).not.toContain(canary);
    expect(hostileEnvelope.event_type).toBe("audit.unavailable");
    expect(hostileEnvelope.provenance).toBe("unavailable");
    expect(
      safeAuditMetadata({
        reasoning: { state: "excluded_by_policy", characters: 999, fields: 2 },
      }).reasoning,
    ).toEqual({ state: "excluded_by_policy", characters: 256, fields: 2 });
    expect(json).toContain("excluded_private_state");
  });

  it("rejects marker-shaped objects in raw fields except policy-produced markers", () => {
    const hostile = safeAuditMetadata({
      prompt: { state: "observed" },
      response: { state: "unavailable" },
      reasoning: { state: "redacted" },
      content: { state: "truncated" },
      arguments: { state: "not_observed" },
      result: { state: "not_yet_available" },
    });
    for (const field of ["prompt", "response", "reasoning", "content", "arguments", "result"])
      expect(hostile[field], "MUTATION_CAUSE:M14-raw-marker-bypass").toEqual({
        state: "excluded_by_policy",
        fields: 1,
      });
    expect(
      safeAuditMetadata({ reasoning: { state: "excluded_private_state", fields: 3 } }).reasoning,
    ).toEqual({ state: "excluded_private_state", fields: 3 });
    expect(
      safeAuditMetadata({ prompt: { state: "excluded_by_policy", characters: 7 } }).prompt,
    ).toEqual({ state: "excluded_by_policy", characters: 7 });

    const privateMarker = { state: "excluded_private_state", fields: 3 };
    const scopedPrivate = safeAuditMetadata({
      prompt: privateMarker,
      response: privateMarker,
      reasoning: privateMarker,
      content: privateMarker,
      arguments: privateMarker,
      result: privateMarker,
    });
    expect(scopedPrivate.reasoning).toEqual(privateMarker);
    for (const field of ["prompt", "response", "content", "arguments", "result"])
      expect(scopedPrivate[field], "MUTATION_CAUSE:M28-private-marker-scope").toEqual({
        state: "excluded_by_policy",
        fields: 2,
      });
    const privateFamily = safeAuditMetadata({
      reasoning_content: privateMarker,
      reasoning_details: privateMarker,
      provider_data: privateMarker,
      encrypted_content: privateMarker,
    });
    for (const field of [
      "reasoning_content",
      "reasoning_details",
      "provider_data",
      "encrypted_content",
    ])
      expect(privateFamily[field], "MUTATION_CAUSE:M31-private-marker-family").toEqual(
        privateMarker,
      );
  });

  it("keeps binary raw-field markers stable across the SQLite read boundary", () => {
    const { connection, audit } = database();
    try {
      audit.append("binary", {
        event_type: "node.completed",
        payload: { result: new Uint8Array(1_000) },
        created_at: 1,
      });
      const stored = JSON.parse(
        String(
          (
            connection.database
              .prepare("SELECT payload_json FROM workflow_audit_events WHERE run_id=?")
              .get("binary") as Readonly<Record<string, unknown>>
          ).payload_json,
        ),
      ) as { readonly data: Readonly<Record<string, unknown>> };
      const returned = audit.query({ runId: "binary" });
      const storedResult = stored.data.result as Readonly<Record<string, unknown>>;
      const returnedResult = returned.events[0]?.data.result as Readonly<Record<string, unknown>>;
      expect(storedResult.state, "MUTATION_CAUSE:M20-binary-marker-policy-state").toBe(
        "excluded_by_policy",
      );
      expect(storedResult.bytes, "MUTATION_CAUSE:M16-binary-marker-idempotence").toBe(1_000);
      expect(returnedResult.bytes, "MUTATION_CAUSE:M23-binary-marker-read-size").toBe(1_000);
      expect(returnedResult, "MUTATION_CAUSE:M16-binary-marker-idempotence").toEqual(storedResult);
      expect(
        (safeAuditMetadata({ before_seq: new Uint8Array(1_000) }).before_seq as { bytes: number })
          .bytes,
        "MUTATION_CAUSE:M24-binary-safe-value-size",
      ).toBe(1_000);
      expect(returned.integrity.field_markers).toMatchObject({ excluded_by_policy: 1 });
    } finally {
      connection.close();
    }
  });

  it("persists attempt and paginates only matching audit events", () => {
    const { connection, audit } = database();
    try {
      audit.append("attempts", { event_type: "node.started", attempt: 1 });
      audit.append("attempts", { event_type: "node.started", attempt: 2 });
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
  it("bounds every persisted identity column before the SQLite boundary", () => {
    const { connection, audit } = database();
    try {
      const runId = `run-${"r".repeat(204)}`;
      audit.append(runId, {
        event_type: "node.started",
        segment_id: `segment-${"s".repeat(156)}`,
        node_id: `node-${"n".repeat(104)}`,
        sub_id: `sub-${"u".repeat(156)}`,
        created_at: 1,
      });
      const row = connection.database
        .prepare("SELECT run_id,segment_id,node_id,sub_id FROM workflow_audit_events LIMIT 1")
        .get() as Readonly<Record<string, string>>;
      expect(
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, Array.from(value).length]),
        ),
        "MUTATION_CAUSE:M13-unbounded-sqlite-identity",
      ).toEqual({ run_id: 128, segment_id: 128, node_id: 64, sub_id: 128 });
      expect(audit.query({ runId }).events).toHaveLength(1);
      expect(
        connection.database.prepare("SELECT length(run_id) AS n FROM workflow_audit_state").get(),
      ).toEqual({ n: 128n });
    } finally {
      connection.close();
    }
  });

  it("keeps overlong run identifiers distinct after applying the public bound", () => {
    const { connection, audit } = database();
    try {
      const shared = "r".repeat(160);
      const left = `${shared}-left`;
      const right = `${shared}-right`;
      audit.append(left, { event_type: "node.started", created_at: 1 });
      audit.append(right, { event_type: "leaf.failed", created_at: 2 });
      const stored = connection.database
        .prepare("SELECT run_id FROM workflow_audit_state ORDER BY run_id")
        .all() as readonly { readonly run_id: string }[];
      expect(stored, "MUTATION_CAUSE:M18-run-id-collision").toHaveLength(2);
      expect(stored[0]?.run_id).not.toBe(stored[1]?.run_id);
      expect(stored.every((row) => Array.from(row.run_id).length === 128)).toBe(true);
      expect(audit.query({ runId: left }).events.map((event) => event.event_type)).toEqual([
        "node.started",
      ]);
      expect(audit.query({ runId: right }).events.map((event) => event.event_type)).toEqual([
        "leaf.failed",
      ]);
    } finally {
      connection.close();
    }
  });

  it("allocates dense seq, freezes snapshots and keeps run-wide integrity notices", () => {
    const { connection, audit } = database({ maxEventsPerRun: 3 });
    try {
      for (let index = 1; index <= 5; index += 1)
        expect(
          audit.append("run", {
            event_type: "node.started",
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
      audit.append("r1", { event_type: "node.started", created_at: 1 });
      audit.append("r2", { event_type: "node.started", created_at: 2 });
      expect(audit.append("r1", { event_type: "node.started", created_at: 3 })?.seq).toBe(2);
      expect(
        (audit.query({ runId: "r1" }).integrity.notices as readonly unknown[])[0],
      ).toMatchObject({ event_type: "audit.gap" });
      audit.append("fresh", { event_type: "node.started", created_at: 100 });
      audit.append("newer", { event_type: "node.started", created_at: 200 });
      expect(audit.append("r1", { event_type: "node.started", created_at: 200 })?.seq).toBe(1);
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
          { event_type: "node.started", created_at: 2 },
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
          { event_type: "node.started", created_at: 2 },
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
      expect(() => audit.append("rollback", { event_type: "node.started", created_at: 1 })).toThrow(
        "planted failure",
      );
      connection.database.exec("DROP TRIGGER fail_audit");
      expect(
        audit.append("rollback", { event_type: "node.started", created_at: 2 })?.seq,
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
    expect(trail.record("r", { event_type: "node.started" })).toBe(true);
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
    failed.record("r", { event_type: "node.started" });
    expect(await failed.shutdown(100)).toBe(false);
    expect(warnings.join(" ")).toContain("failed");
  });

  it("never retries the sink after a timed-out shutdown returns", async () => {
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repo = {
      append: () => {
        attempts += 1;
        throw new Error("database is locked");
      },
      isBusyError: () => true,
    } as unknown as AuditRepository;
    const warnings: string[] = [];
    const trail = new AuditTrail(repo, {
      retryLimit: 6,
      retryDelayMs: 0,
      sleep: () => gate,
      warning: (message) => warnings.push(message),
    });
    expect(trail.record("shutdown", { event_type: "node.started" })).toBe(true);
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(await trail.shutdown(1)).toBe(false);
    const attemptsAtReturn = attempts;
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(attempts, "MUTATION_CAUSE:M25-no-late-shutdown-attempts").toBe(attemptsAtReturn);
    expect(warnings.join(" ")).toContain("shutdown timed out");
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
    expect(await trail.flush(), "MUTATION_CAUSE:M11-stale-refusal-poisons-writer").toBe(true);
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
    await Promise.resolve();
    expect(trail.record("run-y", { event_type: "two" })).toBe(true);
    expect(trail.record("run-x", { event_type: "three" })).toBe(false);
    release();
    expect(await trail.flush()).toBe(true);
    expect(inputs, "MUTATION_CAUSE:M3-silent-overflow").toContain("run-x:audit.gap");
    expect(inputs).not.toContain("run-y:audit.gap");
  });

  it("bounds loss buckets and conserves every overflowed event", async () => {
    expect(
      safeAuditMetadata({ run_attribution: "unavailable" }).run_attribution,
      "MUTATION_CAUSE:M30-drop-attribution-allowlist",
    ).toBe("unavailable");
    const persisted: {
      runId: string;
      reason: unknown;
      count: unknown;
      attribution: unknown;
    }[] = [];
    const repo = {
      append: (runId: string, input: { event_type: string; payload?: Record<string, unknown> }) => {
        if (input.event_type === "audit.gap") {
          const payload = safeAuditMetadata(input.payload ?? {});
          persisted.push({
            runId,
            reason: payload.reason,
            count: payload.dropped_count,
            attribution: payload.run_attribution,
          });
        }
        return {} as never;
      },
      isBusyError: () => false,
    } as unknown as AuditRepository;
    const trail = new AuditTrail(repo, { capacity: 1 });
    expect(trail.record("seed", { event_type: "node.started" })).toBe(true);
    for (let index = 0; index < 2_000; index += 1)
      expect(trail.record(`overflow-${String(index)}`, { event_type: "node.started" })).toBe(false);
    const internal = trail as unknown as {
      readonly dropped: readonly { count: number; reason: string; runId: string }[];
    };
    expect(internal.dropped.length, "MUTATION_CAUSE:M26-bounded-drop-buckets").toBe(256);
    expect(internal.dropped.reduce((total, marker) => total + marker.count, 0)).toBe(2_000);
    expect(internal.dropped).toContainEqual(
      expect.objectContaining({ runId: "$audit", reason: "drop_bucket_overflow" }),
    );
    expect(await trail.flush()).toBe(true);
    expect(persisted.reduce((total, marker) => total + Number(marker.count), 0)).toBe(2_000);
    expect(persisted).toContainEqual(
      expect.objectContaining({
        runId: "$audit",
        reason: "drop_bucket_overflow",
        attribution: "unavailable",
      }),
    );
    expect(
      persisted.find((marker) => marker.runId === "$audit")?.attribution,
      "MUTATION_CAUSE:M29-drop-attribution-emission",
    ).toBe("unavailable");
  });

  it("preserves corrupt_payload when sanitizer failure meets a full queue", async () => {
    const gaps: unknown[] = [];
    const repo = {
      append: (
        _runId: string,
        input: { event_type: string; payload?: Record<string, unknown> },
      ) => {
        if (input.event_type === "audit.gap") gaps.push(input.payload?.reason);
        return {} as never;
      },
      isBusyError: () => false,
    } as unknown as AuditRepository;
    const trail = new AuditTrail(repo, { capacity: 1 });
    expect(trail.record("seed", { event_type: "node.started" })).toBe(true);
    const hostile = new Proxy(Object.create(null) as Record<string, unknown>, {
      ownKeys: () => {
        throw new Error("hostile ownKeys");
      },
    });
    expect(trail.record("corrupt", { event_type: "node.started", payload: hostile })).toBe(false);
    expect(await trail.flush()).toBe(true);
    expect(gaps, "MUTATION_CAUSE:M27-corrupt-payload-cause").toEqual(["corrupt_payload"]);
  });

  it("persists an already accepted event before its overflow gap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const events: string[] = [];
    const repo = {
      append: (_runId: string, input: { event_type: string }) => {
        if (first) {
          first = false;
          throw new Error("database is locked");
        }
        events.push(input.event_type);
        return {} as never;
      },
      isBusyError: (error: unknown) => error instanceof Error && /locked/.test(error.message),
    } as unknown as AuditRepository;
    const trail = new AuditTrail(repo, { capacity: 1, retryDelayMs: 0, sleep: () => gate });
    expect(trail.record("causal", { event_type: "node.started" })).toBe(true);
    await Promise.resolve();
    expect(trail.record("causal", { event_type: "node.completed" })).toBe(true);
    expect(trail.record("causal", { event_type: "node.failed" })).toBe(false);
    release();
    expect(await trail.flush()).toBe(true);
    expect(events, "MUTATION_CAUSE:M15-gap-before-accepted-event").toEqual([
      "node.started",
      "node.completed",
      "audit.gap",
    ]);
  });

  it("separates overflow gaps when an accepted event starts a new loss epoch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    let reentered = false;
    const events: string[] = [];
    let enqueueEpoch = (): void => undefined;
    const repo = {
      append: (_runId: string, input: { event_type: string }) => {
        if (first) {
          first = false;
          throw new Error("database is locked");
        }
        events.push(input.event_type);
        if (input.event_type === "node.completed" && !reentered) {
          reentered = true;
          enqueueEpoch();
        }
        return {} as never;
      },
      isBusyError: (error: unknown) => error instanceof Error && /locked/.test(error.message),
    } as unknown as AuditRepository;
    const trail = new AuditTrail(repo, {
      capacity: 1,
      retryDelayMs: 0,
      sleep: () => gate,
    });
    enqueueEpoch = () => {
      expect(trail.record("epochs", { event_type: "leaf.started" })).toBe(true);
      expect(trail.record("epochs", { event_type: "leaf.failed" })).toBe(false);
    };

    expect(trail.record("epochs", { event_type: "node.started" })).toBe(true);
    await Promise.resolve();
    expect(trail.record("epochs", { event_type: "node.completed" })).toBe(true);
    expect(trail.record("epochs", { event_type: "node.failed" })).toBe(false);
    release();
    expect(await trail.flush()).toBe(true);
    expect(events, "MUTATION_CAUSE:M17-overflow-epochs").toEqual([
      "node.started",
      "node.completed",
      "audit.gap",
      "leaf.started",
      "audit.gap",
    ]);
  });

  it("prevents a reentrant record from starting a concurrent drain", async () => {
    let enqueueReentrant = (): void => undefined;
    let active = 0;
    let maximumActive = 0;
    let reentered = false;
    const events: string[] = [];
    const repo = {
      append: (_runId: string, input: { event_type: string }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push(input.event_type);
        if (!reentered) {
          reentered = true;
          enqueueReentrant();
        }
        active -= 1;
        return {} as never;
      },
      isBusyError: () => false,
    } as unknown as AuditRepository;
    const trail = new AuditTrail(repo);
    enqueueReentrant = () => {
      expect(trail.record("reentrant", { event_type: "node.completed" })).toBe(true);
    };
    expect(trail.record("reentrant", { event_type: "node.started" })).toBe(true);
    expect(await trail.flush()).toBe(true);
    expect(maximumActive, "MUTATION_CAUSE:M19-reentrant-drain").toBe(1);
    expect(events).toEqual(["node.started", "node.completed"]);
  });

  it("releases accepted-order bookkeeping after runs become idle", async () => {
    const repo = {
      append: () => ({}) as never,
      isBusyError: () => false,
    } as unknown as AuditRepository;
    const trail = new AuditTrail(repo, { capacity: 5_001 });
    for (let index = 0; index < 5_000; index += 1)
      expect(trail.record(`idle-${String(index)}`, { event_type: "node.started" })).toBe(true);
    expect(await trail.flush()).toBe(true);
    const internal = trail as unknown as {
      readonly lastAcceptedOrder: ReadonlyMap<string, number>;
    };
    expect(internal.lastAcceptedOrder.size, "MUTATION_CAUSE:M21-bounded-accepted-order").toBe(0);
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

  it("rejects a non-finite watch poll before opening durable state", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t17-cli-"));
    roots.push(root);
    const watchIo = io(root);
    expect(await runCli(["workflow", "watch", "run", "--poll", "NaN"], watchIo.value)).toBe(2);
    expect(watchIo.stderr.join("")).toContain("argument --poll: invalid float value: 'NaN'");
    expect(existsSync(join(root, ".lohra", "state.db"))).toBe(false);
  });
});
