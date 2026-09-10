import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GatewaySessionRegistry } from "../src/gateway/session-service.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";

const roots: string[] = [];

function setup(): {
  readonly registry: GatewaySessionRegistry;
  readonly sessions: SessionRepository;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-compaction-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  return { registry: new GatewaySessionRegistry(sessions), sessions };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

// Issue #252: compaction preflight rewrites history IN PLACE
// (SessionRepository.compactHistory) instead of the alternative this
// module's end_reason=compression resurrection path was built for (closing
// the session and opening a continuation) -- decision (i) in
// docs/context-compaction.md, chosen specifically because it needs none of
// this file's machinery. A compacted session is never ended: it stays
// submittable exactly like any other live session throughout, and
// end_reason stays untouched (null), never becoming "compression". The
// pre-existing end_reason=compression resurrection mechanic itself
// (ADR-T12-04) is covered by tests/gateway/session-service.test.ts and is
// never touched by this issue.
describe("GatewaySessionRegistry — coherent across a compaction (issue #252)", () => {
  it("stays submittable across a compaction -- end_reason is never touched by it", () => {
    const { registry, sessions } = setup();
    sessions.createSession({ id: "s", model: "m", startedAt: 10 });
    sessions.recordTurn("s", {
      user: { role: "user", content: "q" },
      assistant: { role: "assistant", content: "a" },
    });
    expect(registry.canSubmitPrompt("s")).toBe(true);

    expect(sessions.acquireCompressionLock("s", "holder", 100, 30)).toBe(true);
    sessions.compactHistory("s", "holder", 100, { keepTailCount: 0, summary: "recap" });
    sessions.releaseCompressionLock("s", "holder");

    expect(sessions.getSession("s")?.end_reason).toBeNull();
    expect(registry.canSubmitPrompt("s")).toBe(true);
    expect(registry.promptSubmissionRejection("s")).toBeNull();
  });
});
