// Issue #589 (épico #575 P13): unit coverage for the overlay's own pure
// pieces — `claimLineageNotices`/`formatNoticeOverlay`/`buildTurnNotice`/
// `createTurnNoticesPort` — over fakes, never a real sqlite connection
// (`tests/state-notices-repository.test.ts` covers the real
// `NoticesRepository` accepting the new `session:<id>` scope).
import { describe, expect, it } from "vitest";

import {
  buildTurnNotice,
  claimLineageNotices,
  createTurnNoticesPort,
  formatNoticeOverlay,
  NOTICE_OVERLAY_MAX_CHARS,
  type NoticeRow,
  type NoticesOverlayRepository,
} from "../src/context/notices-overlay.js";

interface StoredRow extends NoticeRow {
  acked: boolean;
}

class FakeNoticesRepository implements NoticesOverlayRepository {
  private nextId = 1;
  readonly rows: StoredRow[] = [];
  readonly ackCalls: number[] = [];

  seed(scope: string, kind: string, message: string): NoticeRow {
    const row: StoredRow = { id: this.nextId, scope, kind, message, acked: false };
    this.nextId += 1;
    this.rows.push(row);
    return row;
  }

  list(query: { readonly scope?: string; readonly includeAcked?: boolean }): {
    readonly notices: readonly NoticeRow[];
  } {
    const includeAcked = query.includeAcked ?? false;
    return {
      notices: this.rows.filter((row) => row.scope === query.scope && (includeAcked || !row.acked)),
    };
  }

  ack(id: number): boolean {
    this.ackCalls.push(id);
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined || row.acked) return false;
    row.acked = true;
    return true;
  }

  append(scope: string, input: { readonly kind: string; readonly message: string }): NoticeRow {
    return this.seed(scope, input.kind, input.message);
  }
}

class FakeSessions {
  constructor(private readonly lineages: Readonly<Record<string, readonly string[]>>) {}
  lineageRootToTip(sessionId: string): readonly string[] {
    return this.lineages[sessionId] ?? [sessionId];
  }
}

describe("claimLineageNotices (#589)", () => {
  it("reads pending notices from global and every owner's session scope, deduped", () => {
    const repo = new FakeNoticesRepository();
    repo.seed("global", "unknown", "a global notice");
    repo.seed("session:parent", "route_fault", "parent notice");
    repo.seed("session:child", "cancelled", "child notice");
    repo.seed("session:unrelated", "unknown", "not in this lineage");

    const rows = claimLineageNotices(repo, ["parent", "child"]);

    expect(rows.map((row) => row.message).sort()).toEqual(
      ["a global notice", "child notice", "parent notice"].sort(),
    );
  });

  it("never returns an already-acked notice", () => {
    const repo = new FakeNoticesRepository();
    const acked = repo.seed("session:s1", "unknown", "already seen");
    repo.ack(acked.id);
    repo.seed("session:s1", "unknown", "still pending");

    const rows = claimLineageNotices(repo, ["s1"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe("still pending");
  });

  it("never claims a run:<id> scope even when an owner id collides with a run id", () => {
    const repo = new FakeNoticesRepository();
    repo.seed("run:s1", "route_fault", "a workflow run's own pause, not this session's");

    const rows = claimLineageNotices(repo, ["s1"]);

    expect(rows).toHaveLength(0);
  });
});

describe("formatNoticeOverlay (#589 AC1/AC2)", () => {
  it("returns null text and no included rows for an empty claim", () => {
    const result = formatNoticeOverlay([]);
    expect(result.text).toBeNull();
    expect(result.included).toEqual([]);
  });

  it("formats every row, bounded markers, when everything fits", () => {
    const rows: NoticeRow[] = [
      { id: 1, scope: "global", kind: "unknown", message: "first" },
      { id: 2, scope: "session:s1", kind: "route_fault", message: "second" },
    ];
    const result = formatNoticeOverlay(rows);
    expect(result.text).not.toBeNull();
    expect(result.text as string).toContain("OPERATOR NOTICES");
    expect(result.text as string).toContain("first");
    expect(result.text as string).toContain("second");
    expect(result.included).toHaveLength(2);
    expect((result.text as string).length).toBeLessThanOrEqual(NOTICE_OVERLAY_MAX_CHARS);
  });

  it("leaves whatever doesn't fit the 4096-char cap out of `included` (AC2)", () => {
    const rows: NoticeRow[] = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      scope: "global",
      kind: "unknown",
      message: `notice number ${String(index)} `.repeat(20),
    }));
    const result = formatNoticeOverlay(rows);
    expect(result.included.length).toBeLessThan(rows.length);
    expect((result.text as string).length).toBeLessThanOrEqual(NOTICE_OVERLAY_MAX_CHARS);
    // The lowest ids (oldest) are the ones kept.
    expect(result.included[0]?.id).toBe(1);
  });
});

describe("buildTurnNotice (#589 AC4)", () => {
  it("maps a known ConversationError code to its NoticeKind", () => {
    const notice = buildTurnNotice("CONTEXT_WINDOW_EXCEEDED", new Error("too big"));
    expect(notice.kind).toBe("context_length");
    expect(notice.message).toContain("too big");
  });

  it("falls back to unknown for a code outside the frozen vocabulary map", () => {
    const notice = buildTurnNotice("SOMETHING_NEW", new Error("boom"));
    expect(notice.kind).toBe("unknown");
  });
});

describe("createTurnNoticesPort (#589)", () => {
  it("claim() returns the overlay and a token limited to the included rows", () => {
    const repo = new FakeNoticesRepository();
    repo.seed("session:s1", "unknown", "pending for s1");
    const sessions = new FakeSessions({});
    const port = createTurnNoticesPort({ repository: repo, sessions });

    const claim = port.claim("s1");

    expect(claim.overlay).toContain("pending for s1");
    expect(claim.token).toEqual([1]);
  });

  it("claim() returns a null overlay and empty token when there is nothing pending", () => {
    const repo = new FakeNoticesRepository();
    const sessions = new FakeSessions({});
    const port = createTurnNoticesPort({ repository: repo, sessions });

    const claim = port.claim("s1");

    expect(claim.overlay).toBeNull();
    expect(claim.token).toEqual([]);
  });

  it("ack() acknowledges exactly the ids in the token", () => {
    const repo = new FakeNoticesRepository();
    repo.seed("session:s1", "unknown", "one");
    repo.seed("session:s1", "unknown", "two");
    const sessions = new FakeSessions({});
    const port = createTurnNoticesPort({ repository: repo, sessions });

    port.ack([1, 2]);

    expect(repo.rows.every((row) => row.acked)).toBe(true);
  });

  it("publishFailure() appends a session-scoped notice with the mapped kind", () => {
    const repo = new FakeNoticesRepository();
    const sessions = new FakeSessions({});
    const port = createTurnNoticesPort({ repository: repo, sessions });

    port.publishFailure("s1", "CONTEXT_WINDOW_EXCEEDED", new Error("boom"));

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.scope).toBe("session:s1");
    expect(repo.rows[0]?.kind).toBe("context_length");
  });

  it("fails open — a repository that throws never propagates out of claim/ack/publishFailure", () => {
    const throwingRepo: NoticesOverlayRepository = {
      list() {
        throw new Error("db unavailable");
      },
      ack() {
        throw new Error("db unavailable");
      },
      append() {
        throw new Error("db unavailable");
      },
    };
    const sessions = new FakeSessions({});
    const warnings: string[] = [];
    const port = createTurnNoticesPort({
      repository: throwingRepo,
      sessions,
      warning: (message) => warnings.push(message),
    });

    expect(() => port.claim("s1")).not.toThrow();
    expect(() => {
      port.ack([1]);
    }).not.toThrow();
    expect(() => {
      port.publishFailure("s1", "TURN_FAILED", new Error("x"));
    }).not.toThrow();
    expect(port.claim("s1")).toEqual({ token: [], overlay: null });
    expect(warnings.length).toBeGreaterThan(0);
  });
});
