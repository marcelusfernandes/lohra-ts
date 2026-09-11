// Issue #400 (M8-4): `NoticesRepository` é o irmão de `AuditRepository`
// (`src/state/audit-repository.ts`) para avisos ao operador. Duas conexões
// reais (`openStateDatabase` ×2) para o mesmo arquivo simulam dois
// processos de verdade — o predicado de dono (`append`) lê o fence do
// disco, não de um cache em memória do processo que escreveu primeiro; uma
// única conexão reaproveitada por "dono" e "ladrão" não provaria isso.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, LockRepository } from "../src/state/index.js";
import {
  NoticesRepository,
  NOTICE_KINDS,
  NOTICES_SCOPE_CAP,
  type PublicNotice,
} from "../src/state/notices-repository.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tempDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-notices-"));
  roots.push(root);
  return join(root, "state.db");
}

function ownershipOf(
  fence: ReturnType<LockRepository["acquireRunLease"]>,
  holder: string,
  now: number,
): { fence: number; holder: string; now: number } {
  if (fence === null) throw new Error("expected lease token");
  return { fence, holder, now };
}

describe("NoticesRepository", () => {
  it("owner writes under the current fence, visible through a second connection (durable, not cached)", () => {
    const path = tempDbPath();
    const connectionA = openStateDatabase(path);
    const connectionB = openStateDatabase(path);
    try {
      const locksA = new LockRepository(connectionA.database);
      const noticesA = new NoticesRepository(connectionA.database);
      const fence = locksA.acquireRunLease("run-1", "owner", 1000, 100);
      const written = noticesA.append(
        "run:run-1",
        { kind: "quota_exhausted", message: "budget exhausted" },
        ownershipOf(fence, "owner", 1000),
      );
      expect(written).not.toBeNull();
      expect((written as PublicNotice).seq).toBe(1);

      const noticesB = new NoticesRepository(connectionB.database);
      const page = noticesB.list({ scope: "run:run-1" });
      expect(page.notices).toHaveLength(1);
      expect(page.notices[0]?.kind).toBe("quota_exhausted");
      expect(page.notices[0]?.message).toBe("budget exhausted");
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("refuses a stale fence (takeover happened on another connection), counts it once, warns once", () => {
    const path = tempDbPath();
    const connectionA = openStateDatabase(path);
    const connectionB = openStateDatabase(path);
    try {
      const locksA = new LockRepository(connectionA.database);
      const staleFence = locksA.acquireRunLease("run-2", "owner", 1000, 100);
      // The lease expires at 1100; the thief re-acquires past that, on its
      // OWN connection — the fence bump has to be visible cross-connection
      // for the refusal below to be real, not an artifact of one shared handle.
      const locksB = new LockRepository(connectionB.database);
      locksB.acquireRunLease("run-2", "thief", 1200, 100);

      const warnings: string[] = [];
      const noticesA = new NoticesRepository(connectionA.database, {
        warning: (message) => warnings.push(message),
      });
      const refused = noticesA.append(
        "run:run-2",
        { kind: "sandbox_denied", message: "denied" },
        ownershipOf(staleFence, "owner", 1200),
      );
      expect(refused).toBeNull();
      expect(warnings).toHaveLength(1);
      const page = noticesA.list({ scope: "run:run-2" });
      expect(page.refused_writes).toBe(1);
      expect(page.notices).toHaveLength(0);
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("refuses a run scope append with no ownership at all (invariant: cross-process writes always fenced)", () => {
    const path = tempDbPath();
    const connection = openStateDatabase(path);
    try {
      const notices = new NoticesRepository(connection.database);
      const refused = notices.append("run:run-3", { kind: "timeout", message: "x" });
      expect(refused).toBeNull();
    } finally {
      connection.close();
    }
  });

  it("global scope writes without ownership", () => {
    const path = tempDbPath();
    const connection = openStateDatabase(path);
    try {
      const notices = new NoticesRepository(connection.database);
      const written = notices.append("global", {
        kind: "audit_sink_failure",
        message: "sink down",
      });
      expect(written).not.toBeNull();
      expect((written as PublicNotice).scope).toBe("global");
      expect((written as PublicNotice).fence).toBeNull();
    } finally {
      connection.close();
    }
  });

  it("refuses an invalid scope (neither global nor run:<id>), never writes", () => {
    const path = tempDbPath();
    const connection = openStateDatabase(path);
    try {
      const notices = new NoticesRepository(connection.database);
      const refused = notices.append("weird-scope", { kind: "unknown", message: "x" });
      expect(refused).toBeNull();
      expect(notices.list({ scope: "weird-scope" }).notices).toHaveLength(0);
    } finally {
      connection.close();
    }
  });

  it("refuses a kind outside NOTICE_KINDS, named, never writes, never throws", () => {
    const path = tempDbPath();
    const connection = openStateDatabase(path);
    try {
      const warnings: string[] = [];
      const notices = new NoticesRepository(connection.database, {
        warning: (message) => warnings.push(message),
      });
      expect(() =>
        notices.append("global", { kind: "not-a-real-kind", message: "x" }),
      ).not.toThrow();
      const refused = notices.append("global", { kind: "not-a-real-kind", message: "x" });
      expect(refused).toBeNull();
      expect(warnings.some((message) => message.includes("not-a-real-kind"))).toBe(true);
      expect(notices.list({ scope: "global" }).notices).toHaveLength(0);
    } finally {
      connection.close();
    }
  });

  it("truncates a message over 2 KiB with a marker, on a UTF-8 boundary", () => {
    const path = tempDbPath();
    const connection = openStateDatabase(path);
    try {
      const notices = new NoticesRepository(connection.database);
      const huge = "é".repeat(2000); // multi-byte char, forces a boundary decision
      const written = notices.append("global", { kind: "unknown", message: huge });
      expect(written).not.toBeNull();
      const message = (written as PublicNotice).message;
      expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(2048);
      expect(message.endsWith("…[truncated]")).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("ack is idempotent: first call true, second call false, acked_at only visible with includeAcked", () => {
    const path = tempDbPath();
    const connection = openStateDatabase(path);
    try {
      const notices = new NoticesRepository(connection.database);
      const written = notices.append("global", { kind: "unknown", message: "x" });
      const id = (written as PublicNotice).id;
      expect(notices.ack(id, "operator-1", 2000)).toBe(true);
      expect(notices.ack(id, "operator-1", 2000)).toBe(false);

      const defaultPage = notices.list({ scope: "global" });
      expect(defaultPage.notices).toHaveLength(0);

      const withAcked = notices.list({ scope: "global", includeAcked: true });
      expect(withAcked.notices).toHaveLength(1);
      expect(withAcked.notices[0]?.acked_at).toBe(2000);
      expect(withAcked.notices[0]?.acked_by).toBe("operator-1");
    } finally {
      connection.close();
    }
  });

  it("ack of an unknown id returns false, never throws", () => {
    const path = tempDbPath();
    const connection = openStateDatabase(path);
    try {
      const notices = new NoticesRepository(connection.database);
      expect(notices.ack(999_999, "operator-1")).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("retention: acked notices fall first; an unacked notice never falls while an acked one can", () => {
    const path = tempDbPath();
    const connection = openStateDatabase(path);
    try {
      const notices = new NoticesRepository(connection.database, { maxPerScope: 3 });
      // 4 notices: #1 and #2 acked, #3 and #4 unacked. Cap 3 → 1 must fall,
      // and it must be an acked one (the oldest acked), never #3/#4.
      const first = notices.append("global", { kind: "unknown", message: "1" });
      const secondNotice = notices.append("global", { kind: "unknown", message: "2" });
      notices.append("global", { kind: "unknown", message: "3" });
      notices.append("global", { kind: "unknown", message: "4" });
      notices.ack((first as PublicNotice).id, "op");
      notices.ack((secondNotice as PublicNotice).id, "op");

      const page = notices.list({ scope: "global", includeAcked: true });
      expect(page.notices).toHaveLength(3);
      expect(page.notices.map((n) => n.message)).toEqual(["2", "3", "4"]);
      expect(page.dropped_before_seq).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("exports the closed vocabulary and the scope cap constant", () => {
    expect(NOTICE_KINDS).toContain("quota_exhausted");
    expect(NOTICE_KINDS).toContain("stale_fence_write");
    expect(NOTICE_KINDS).toContain("audit_sink_failure");
    expect(NOTICE_KINDS).toContain("resume_attempts_exhausted");
    expect(NOTICE_KINDS).toContain("queue_overflow");
    expect(NOTICES_SCOPE_CAP).toBe(256);
  });
});
