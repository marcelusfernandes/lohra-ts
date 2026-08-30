import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, SessionRepository } from "../../src/state/index.js";
import { GatewaySessionRegistry } from "../../src/gateway/session-service.js";
import {
  DOCUMENTED_AND_ABSENT_RPC_METHODS,
  dispatchSyncRpc,
} from "../../src/gateway/rpc/dispatch.js";

const roots: string[] = [];

function setup(): { readonly registry: GatewaySessionRegistry; readonly sessions: SessionRepository } {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-dispatch-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  return { registry: new GatewaySessionRegistry(sessions), sessions };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const SESSION_DEFAULTS = { model: "gpt-5", systemPrompt: "sp", cwd: "/tmp" };

describe("dispatchSyncRpc: session.create", () => {
  it("creates a session and asks the caller to emit session.info", () => {
    const { registry } = setup();
    const outcome = dispatchSyncRpc(registry, "session.create", {}, SESSION_DEFAULTS);
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw new Error("expected result");
    const result = outcome.result as { session_id: string };
    expect(result.session_id).toMatch(/^[0-9a-f]{32}$/);
    expect(outcome.emitSessionInfoFor).toBe(result.session_id);
  });

  it("re-emits session.info on idempotent re-creation", () => {
    const { registry } = setup();
    const first = dispatchSyncRpc(registry, "session.create", { session_id: "s1" }, SESSION_DEFAULTS);
    const second = dispatchSyncRpc(registry, "session.create", { session_id: "s1" }, SESSION_DEFAULTS);
    if (first.kind !== "result" || second.kind !== "result") throw new Error("expected result");
    expect(first.emitSessionInfoFor).toBe("s1");
    expect(second.emitSessionInfoFor).toBe("s1");
  });
});

describe("dispatchSyncRpc: session.list / session.history / session.interrupt", () => {
  it("session.list returns {sessions: [...]}", () => {
    const { registry } = setup();
    dispatchSyncRpc(registry, "session.create", { session_id: "a" }, SESSION_DEFAULTS);
    const outcome = dispatchSyncRpc(registry, "session.list", {}, SESSION_DEFAULTS);
    if (outcome.kind !== "result") throw new Error("expected result");
    expect(outcome.result).toEqual({ sessions: registry.list() });
  });

  it("session.history returns {messages: []} for an unknown or missing id", () => {
    const { registry } = setup();
    expect(dispatchSyncRpc(registry, "session.history", {}, SESSION_DEFAULTS)).toEqual({
      kind: "result",
      result: { messages: [] },
    });
    expect(
      dispatchSyncRpc(registry, "session.history", { session_id: "nope" }, SESSION_DEFAULTS),
    ).toEqual({ kind: "result", result: { messages: [] } });
  });

  it("session.interrupt returns {ok:false} for unknown/missing id and {ok:true} for known", () => {
    const { registry } = setup();
    dispatchSyncRpc(registry, "session.create", { session_id: "s1" }, SESSION_DEFAULTS);
    expect(dispatchSyncRpc(registry, "session.interrupt", {}, SESSION_DEFAULTS)).toEqual({
      kind: "result",
      result: { ok: false },
    });
    expect(
      dispatchSyncRpc(registry, "session.interrupt", { session_id: "s1" }, SESSION_DEFAULTS),
    ).toEqual({ kind: "result", result: { ok: true } });
  });
});

describe("dispatchSyncRpc: prompt.submit and unknown methods", () => {
  it("routes prompt.submit to the caller (async streaming path) instead of handling it", () => {
    const { registry } = setup();
    expect(dispatchSyncRpc(registry, "prompt.submit", {}, SESSION_DEFAULTS)).toEqual({
      kind: "unhandled",
    });
  });

  it("returns -32601 for a genuinely unknown method", () => {
    const { registry } = setup();
    const outcome = dispatchSyncRpc(registry, "nonexistent.method", {}, SESSION_DEFAULTS);
    expect(outcome).toEqual({
      kind: "error",
      code: -32601,
      message: "unknown method: nonexistent.method",
    });
  });
});

describe("DOCUMENTED_AND_ABSENT_RPC_METHODS", () => {
  it("has exactly 39 literal method names, all resolving to -32601", () => {
    expect(DOCUMENTED_AND_ABSENT_RPC_METHODS).toHaveLength(39);
    expect(new Set(DOCUMENTED_AND_ABSENT_RPC_METHODS).size).toBe(39);
    const { registry } = setup();
    for (const method of DOCUMENTED_AND_ABSENT_RPC_METHODS) {
      expect(dispatchSyncRpc(registry, method, {}, SESSION_DEFAULTS)).toEqual({
        kind: "error",
        code: -32601,
        message: `unknown method: ${method}`,
      });
    }
  });

  it("includes session.steer -- T12's /v1/runs-class trap, never implemented", () => {
    expect(DOCUMENTED_AND_ABSENT_RPC_METHODS).toContain("session.steer");
  });

  it("names every documented-and-absent method literally, no glob prefixes", () => {
    for (const method of DOCUMENTED_AND_ABSENT_RPC_METHODS) {
      expect(method.endsWith(".*")).toBe(false);
      expect(method.endsWith("*")).toBe(false);
    }
  });
});
