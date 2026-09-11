// Issue #425 (M10-S4): `workflow_leaf_read {run_id, sub_id, max_chars?}` — real
// sqlite, no network, same posture as `tests/workflow-notices-tool.test.ts`
// (#402): a real durable store, the handler dispatched directly, built off
// `createSessionToolBase` (`src/commands/session-tools.ts`) for the
// `AuditRepository` this tool shares with `workflow_audit`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSessionToolBase } from "../src/commands/session-tools.js";
import { openStateDatabase, type StateConnection } from "../src/state/connection.js";
import { SessionRepository } from "../src/state/index.js";
import { CHILD_EXCLUDED_TOOLS, createChildDispatch } from "../src/tools/child.js";
import { workflowLeafReadHandler } from "../src/workflow/leaf-read-tool.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

interface Harness {
  readonly connection: StateConnection;
  readonly base: ReturnType<typeof createSessionToolBase>;
  readonly sessions: SessionRepository;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "lohra-leaf-read-tool-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const base = createSessionToolBase(connection.database, {});
  const sessions = new SessionRepository(connection.database);
  return { connection, base, sessions };
}

function handlerFor(target: Harness) {
  return workflowLeafReadHandler(target.connection.database, target.base.auditRepository);
}

/** Mirrors what `child-repository.ts` stamps on every leaf session, and what
 * `audit-runtime.ts:211-228` writes at spawn, without spinning up the whole
 * orchestration engine. */
function plantLeaf(
  target: Harness,
  input: { readonly subId: string; readonly parentId: string; readonly runId: string },
): void {
  target.sessions.createSession({
    id: input.subId,
    source: "orchestration",
    parentSessionId: input.parentId,
  });
  target.base.auditRepository.append(input.runId, {
    event_type: "leaf.started",
    sub_id: input.subId,
    node_id: "worker",
  });
}

interface LeafReadEnvelope {
  readonly ok?: boolean;
  readonly error?: string;
  readonly sub_id?: string;
  readonly run_id?: string;
  readonly truncated?: boolean;
  readonly note?: string;
  readonly turns?: readonly {
    readonly role: string;
    readonly content: string | null;
    readonly created_at: number;
  }[];
}

describe("workflow_leaf_read tool (#425)", () => {
  it("reads the turns already committed by a live leaf", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-1", parentId: "parent-1", runId: "run-1" });
    target.sessions.recordTurn("leaf-1", {
      user: { role: "user", content: "how's the migration going?" },
      assistant: { role: "assistant", content: "half the rows are done" },
    });

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-1", sub_id: "leaf-1" }),
    ) as LeafReadEnvelope;

    expect(parsed.ok, "MUTATION_CAUSE:M425-leaf-read-ok").toBe(true);
    expect(parsed.sub_id).toBe("leaf-1");
    expect(parsed.run_id).toBe("run-1");
    expect(parsed.truncated).toBe(false);
    expect(parsed.note).toBe("turnos assentados; o turno em voo não está gravado");
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns?.[0]).toMatchObject({
      role: "user",
      content: "how's the migration going?",
    });
    expect(parsed.turns?.[1]).toMatchObject({
      role: "assistant",
      content: "half the rows are done",
    });
    expect(typeof parsed.turns?.[0]?.created_at).toBe("number");
  });

  it("truncates content to max_chars and reports truncated:true", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-2", parentId: "parent-1", runId: "run-2" });
    target.sessions.recordTurn("leaf-2", {
      user: { role: "user", content: "0123456789" },
      assistant: { role: "assistant", content: "abcdefghij" },
    });

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-2", sub_id: "leaf-2", max_chars: 12 }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    const combined = (parsed.turns ?? []).map((turn) => turn.content ?? "").join("");
    expect(combined).toHaveLength(12);
    expect(combined).toBe("0123456789ab");
  });

  it("names the error for a sub_id that belongs to a different run", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-3", parentId: "parent-1", runId: "run-3" });

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-other", sub_id: "leaf-3" }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBeUndefined();
    expect(parsed.error).toBeTruthy();
    expect(parsed.error).toContain("leaf-3");
  });

  it("names the error for a sub_id that is not an orchestration leaf", async () => {
    const target = harness();
    target.sessions.createSession({ id: "cli-session", source: "cli" });

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-4", sub_id: "cli-session" }),
    ) as LeafReadEnvelope;

    expect(parsed.error).toBeTruthy();
  });

  it("names the error for an unknown sub_id", async () => {
    const target = harness();
    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-5", sub_id: "ghost" }),
    ) as LeafReadEnvelope;
    expect(parsed.error).toBeTruthy();
  });

  it("is excluded from subagents (CHILD_EXCLUDED_TOOLS + createChildDispatch)", async () => {
    expect(CHILD_EXCLUDED_TOOLS).toContain("workflow_leaf_read");
    const dispatch = createChildDispatch(() => Promise.resolve("{}"));
    const result = JSON.parse(await dispatch("workflow_leaf_read", {})) as { error?: string };
    expect(result.error).toContain("workflow_leaf_read");
    expect(result.error).toContain("not available to subagents");
  });
});
