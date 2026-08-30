import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, SessionRepository } from "../../src/state/index.js";
import { GatewaySessionRegistry } from "../../src/gateway/session-service.js";

const roots: string[] = [];

function setup(): {
  readonly registry: GatewaySessionRegistry;
  readonly sessions: SessionRepository;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-session-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  return { registry: new GatewaySessionRegistry(sessions), sessions };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("GatewaySessionRegistry.createOrResurrect", () => {
  it("creates a fresh session with a 32-char lowercase hex id when none is given", () => {
    const { registry } = setup();
    const result = registry.createOrResurrect({ model: "m", systemPrompt: "sp", cwd: "/tmp" });
    expect(result.created).toBe(true);
    expect(result.sessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("accepts any client-supplied session_id without validation, including path-traversal-shaped values", () => {
    const { registry } = setup();
    const result = registry.createOrResurrect({
      sessionId: "../../etc/passwd",
      model: "m",
      systemPrompt: "sp",
      cwd: "/tmp",
    });
    expect(result.sessionId).toBe("../../etc/passwd");
    expect(result.created).toBe(true);
  });

  it("is idempotent: re-calling with an existing id does not error and reports created:false", () => {
    const { registry } = setup();
    const first = registry.createOrResurrect({
      sessionId: "s1",
      model: "m",
      systemPrompt: "sp",
      cwd: "/tmp",
    });
    const second = registry.createOrResurrect({
      sessionId: "s1",
      model: "m",
      systemPrompt: "sp",
      cwd: "/tmp",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe("s1");
  });

  it("resurrects a session whose end_reason is 'compression' (ADR-T12-04) -- no gating on end_reason", () => {
    const { registry, sessions } = setup();
    sessions.createSession({ id: "parent", model: "m", startedAt: 10 });
    sessions.endSession("parent", "compression", 20);
    expect(sessions.getSession("parent")?.end_reason).toBe("compression");

    const result = registry.createOrResurrect({
      sessionId: "parent",
      model: "m",
      systemPrompt: "sp",
      cwd: "/tmp",
    });
    expect(result.created).toBe(false);
    expect(result.sessionId).toBe("parent");
    // create_session() only consults the in-memory/DB existence check, not
    // end_reason -- the row is unchanged, it's simply usable again.
    expect(sessions.getSession("parent")?.end_reason).toBe("compression");
  });
});

describe("GatewaySessionRegistry.history", () => {
  it("returns an empty array for an unknown id, never an error", () => {
    const { registry } = setup();
    expect(registry.history("nope")).toEqual([]);
  });

  it("returns an empty array when the id is missing", () => {
    const { registry } = setup();
    expect(registry.history(undefined)).toEqual([]);
  });

  it("serves the full history of a dead (compressed) parent -- no end_reason gating", () => {
    const { registry, sessions } = setup();
    sessions.createSession({ id: "parent", model: "m", startedAt: 10 });
    sessions.appendMessage("parent", { role: "user", content: "hi", createdAt: 11 });
    sessions.endSession("parent", "compression", 20);
    expect(registry.history("parent")).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("GatewaySessionRegistry.interrupt", () => {
  it("returns {ok:false} for an unknown or missing session id", () => {
    const { registry } = setup();
    expect(registry.interrupt("nope")).toEqual({ ok: false });
    expect(registry.interrupt(undefined)).toEqual({ ok: false });
  });

  it("returns {ok:true} and arms the interrupt latch for a known session", () => {
    const { registry, sessions } = setup();
    sessions.createSession({ id: "s1", model: "m", startedAt: 10 });
    expect(registry.interrupt("s1")).toEqual({ ok: true });
    expect(registry.consumeInterruptLatch("s1")).toBe(true);
  });

  it("consumeInterruptLatch is one-shot: armed once, consumed once", () => {
    const { registry, sessions } = setup();
    sessions.createSession({ id: "s1", model: "m", startedAt: 10 });
    registry.interrupt("s1");
    expect(registry.consumeInterruptLatch("s1")).toBe(true);
    expect(registry.consumeInterruptLatch("s1")).toBe(false);
  });

  it("aborts the active turn's controller instead of arming the latch when a turn is running (L19: cross-socket)", () => {
    const { registry, sessions } = setup();
    sessions.createSession({ id: "s1", model: "m", startedAt: 10 });
    const controller = registry.beginTurn("s1");
    expect(registry.interrupt("s1")).toEqual({ ok: true });
    expect(controller.signal.aborted).toBe(true);
    // Because a turn was active, the idle latch is NOT what fired.
    expect(registry.consumeInterruptLatch("s1")).toBe(false);
  });

  it("endTurn clears the active controller, so a later interrupt goes back to arming the latch", () => {
    const { registry, sessions } = setup();
    sessions.createSession({ id: "s1", model: "m", startedAt: 10 });
    const controller = registry.beginTurn("s1");
    registry.endTurn("s1");
    registry.interrupt("s1");
    expect(controller.signal.aborted).toBe(false);
    expect(registry.consumeInterruptLatch("s1")).toBe(true);
  });
});

describe("GatewaySessionRegistry busy tracking", () => {
  it("is not busy by default, then busy after markBusy, then not after clearBusy", () => {
    const { registry } = setup();
    expect(registry.isBusy("s1")).toBe(false);
    registry.markBusy("s1");
    expect(registry.isBusy("s1")).toBe(true);
    registry.clearBusy("s1");
    expect(registry.isBusy("s1")).toBe(false);
  });
});

describe("GatewaySessionRegistry.list", () => {
  it("proxies SessionRepository.listSessions verbatim, most-recent-first", () => {
    const { registry, sessions } = setup();
    sessions.createSession({ id: "a", model: "m", startedAt: 10 });
    sessions.createSession({ id: "b", model: "m", startedAt: 20 });
    const rows = registry.list();
    expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("returns a JSON-serializable message_count, not a bigint (the state connection runs defaultSafeIntegers(true))", () => {
    const { registry, sessions } = setup();
    sessions.createSession({ id: "a", model: "m", startedAt: 10 });
    sessions.appendMessage("a", { role: "user", content: "hi", createdAt: 11 });
    const [row] = registry.list();
    expect(typeof row?.message_count).toBe("number");
    expect(row?.message_count).toBe(1);
    expect(() => JSON.stringify(registry.list())).not.toThrow();
  });
});

describe("GatewaySessionRegistry.sessionInfo", () => {
  it("has exactly the 4 documented fields -- model, tools, running, version", () => {
    const { registry } = setup();
    const info = registry.sessionInfo({ model: "gpt-5", tools: ["read_file"], running: true });
    expect(Object.keys(info).sort()).toEqual(["model", "running", "tools", "version"]);
    expect(info.model).toBe("gpt-5");
    expect(info.tools).toEqual(["read_file"]);
    expect(info.running).toBe(true);
    expect(typeof info.version).toBe("string");
  });
});
