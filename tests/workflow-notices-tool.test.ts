// Issue #402 (M8-6): `workflow_notices`/`workflow_notices_ack` over the real
// `NoticesRepository` (issue #400) — real sqlite, no network, same posture
// as `tests/workflow-audit-tool.test.ts` (a real durable store, handlers
// dispatched directly), but through `createSessionToolBase`'s own
// `registry` (`src/commands/session-tools.ts`), since that is where these
// two handlers are registered (alongside `workflowAuditHandler`) — not
// `workflowToolHandlers` (`src/workflow/tool.ts`), which stays untouched by
// this issue.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSessionToolBase } from "../src/commands/session-tools.js";
import { openStateDatabase, type StateConnection } from "../src/state/connection.js";
import { NoticesRepository } from "../src/state/notices-repository.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function harness(): {
  readonly connection: StateConnection;
  readonly base: ReturnType<typeof createSessionToolBase>;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-notices-tool-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const base = createSessionToolBase(connection.database, {});
  return { connection, base };
}

interface NoticesListEnvelope {
  readonly ok: boolean;
  readonly notices: readonly {
    readonly id: number;
    readonly message: string;
    readonly acked_at: number | null;
  }[];
  readonly refused_writes: number;
  readonly integrity: { readonly refused_writes: number };
}

interface AckEnvelope {
  readonly ok: boolean;
  readonly acked: boolean;
}

describe("workflow_notices / workflow_notices_ack tools (#402)", () => {
  it("lists a notice written durably by NoticesRepository, acks it, hides it, then shows it again with include_acked", async () => {
    const { connection, base } = harness();
    try {
      const repository = new NoticesRepository(connection.database);
      const written = repository.append("global", {
        kind: "queue_overflow",
        message: "durable notice for the tool surface",
      });
      expect(written).not.toBeNull();
      const noticeId = written?.id;
      if (noticeId === undefined) throw new Error("unreachable: asserted above");

      const listed = JSON.parse(
        await base.registry.dispatch("workflow_notices", {}),
      ) as NoticesListEnvelope;
      expect(listed.ok, "MUTATION_CAUSE:M402-notices-list-wiring").toBe(true);
      expect(listed.notices.map((notice) => notice.id)).toContain(noticeId);
      const found = listed.notices.find((notice) => notice.id === noticeId);
      expect(found?.message).toBe("durable notice for the tool surface");
      // Envelope = `NoticesRepository.list` plus `integrity: {refused_writes}`
      // (issue #402's own AC) — never a SECOND source of truth for the count.
      expect(listed.integrity.refused_writes).toBe(listed.refused_writes);

      const acked = JSON.parse(
        await base.registry.dispatch("workflow_notices_ack", { id: noticeId }),
      ) as AckEnvelope;
      expect(acked.ok).toBe(true);
      expect(acked.acked).toBe(true);

      const afterAck = JSON.parse(
        await base.registry.dispatch("workflow_notices", {}),
      ) as NoticesListEnvelope;
      expect(afterAck.notices.map((notice) => notice.id)).not.toContain(noticeId);

      const withAcked = JSON.parse(
        await base.registry.dispatch("workflow_notices", { include_acked: true }),
      ) as NoticesListEnvelope;
      const rewound = withAcked.notices.find((notice) => notice.id === noticeId);
      expect(rewound?.acked_at).not.toBeNull();
    } finally {
      connection.close();
    }
  });

  it("scopes to run_id when given — a global notice never shows up under a run scope", async () => {
    const { connection, base } = harness();
    try {
      const repository = new NoticesRepository(connection.database);
      repository.append("global", { kind: "queue_overflow", message: "global one" });
      const scoped = JSON.parse(
        await base.registry.dispatch("workflow_notices", { run_id: "no-such-run" }),
      ) as NoticesListEnvelope;
      expect(scoped.notices).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("acking an unknown id is not an error — it just reports acked:false", async () => {
    const { connection, base } = harness();
    try {
      const out = JSON.parse(
        await base.registry.dispatch("workflow_notices_ack", { id: 999_999 }),
      ) as AckEnvelope;
      expect(out.ok).toBe(true);
      expect(out.acked).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("rejects a missing or non-numeric id for workflow_notices_ack", async () => {
    const { connection, base } = harness();
    try {
      const missing = await base.registry.dispatch("workflow_notices_ack", {});
      expect(missing).toContain("error");
      const nonNumeric = await base.registry.dispatch("workflow_notices_ack", { id: "abc" });
      expect(nonNumeric).toContain("error");
    } finally {
      connection.close();
    }
  });

  it("is excluded from subagents, same as workflow_audit", async () => {
    const { childToolDefinitions } = await import("../src/tools/child.js");
    const { connection, base } = harness();
    try {
      const childCatalog = childToolDefinitions(base.registry.getDefinitions()).map(
        (definition) => definition.function.name,
      );
      expect(childCatalog).not.toContain("workflow_notices");
      expect(childCatalog).not.toContain("workflow_notices_ack");
    } finally {
      connection.close();
    }
  });
});
