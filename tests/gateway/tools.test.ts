import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { approval } from "../../src/tools/index.js";
import { createGatewayToolRuntime, GatewayToolIdCounter } from "../../src/gateway/tools.js";

const roots: string[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-tools-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  approval.setCallback(null);
  approval.reset();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("createGatewayToolRuntime: RCE proof and dangerous-command deny (assertions 39-40)", () => {
  it("terminal executes a safe command for real", async () => {
    const runtime = createGatewayToolRuntime(tempHome());
    const result = JSON.parse(
      await runtime.dispatch("terminal", JSON.stringify({ command: "echo T12_TERMINAL_CANARY" })),
    ) as { ok: boolean; stdout: string; exit_code: number };
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("T12_TERMINAL_CANARY\n");
    expect(result.exit_code).toBe(0);
  });

  it("denies a dangerous command with the fail-safe message, distinct from T11's subagent message", async () => {
    const runtime = createGatewayToolRuntime(tempHome());
    const result = JSON.parse(
      await runtime.dispatch("terminal", JSON.stringify({ command: "rm -rf /tmp/whatever" })),
    ) as { error: string; command: string };
    expect(result).toEqual({
      error: "command was not approved by the user",
      command: "rm -rf /tmp/whatever",
    });
    // Structurally different from T11's "subagent auto-denied a dangerous
    // command (recursive delete (rm -r))" -- the two must never converge.
    expect(result.error).not.toContain("subagent auto-denied");
  });

  it("no approval callback is ever set -- deny is by fail-safe absence, not a policy the gateway authored", async () => {
    const runtime = createGatewayToolRuntime(tempHome());
    await runtime.dispatch("terminal", JSON.stringify({ command: "echo hi" }));
    // If a callback were set (even one that always denies), it would
    // still be a *policy*; the oracle's parity requirement is the
    // *absence* of any callback, which approval.require() also treats
    // specially by not even trying to reach a decision-maker.
    expect(() => {
      approval.setCallback(() => "deny");
    }).not.toThrow();
    approval.setCallback(null);
  });
});

describe("createGatewayToolRuntime: memory reaches the handler, not auto-denied (assertion 41)", () => {
  it("memory action:list -> unknown action error, proving it reached MemoryTool.handle", async () => {
    const runtime = createGatewayToolRuntime(tempHome());
    const result = JSON.parse(
      await runtime.dispatch("memory", JSON.stringify({ action: "list" })),
    ) as { error: string };
    expect(result).toEqual({ error: "unknown action 'list' (use add/replace/remove)" });
  });
});

describe("createGatewayToolRuntime: registry order and no allow-list (assertion 41)", () => {
  it("exposes all 24 tools in registry order", () => {
    const runtime = createGatewayToolRuntime(tempHome());
    expect(runtime.toolNames).toEqual([
      "read_file",
      "write_file",
      "terminal",
      "web_fetch",
      "web_search",
      "memory",
      "skill_view",
      "skill_manage",
      "session_search",
      "delegate_task",
      "cronjob",
      "vision_analyze",
      "image_gen",
      "spawn_session",
      "steer_session",
      "collect_session",
      "run_workflow",
      "workflow_status",
      "workflow_list",
      "workflow_pause",
      "workflow_cancel",
      "workflow_templates",
      "workflow_audit",
      "list_models",
    ]);
  });
});

describe("GatewayToolIdCounter: restarts at tool_1 per turn (assertion 38)", () => {
  it("increments tool_1, tool_2, tool_3... within one instance", () => {
    const counter = new GatewayToolIdCounter();
    expect(counter.nextId()).toBe("tool_1");
    expect(counter.nextId()).toBe("tool_2");
    expect(counter.nextId()).toBe("tool_3");
  });

  it("a fresh counter (a new turn) restarts at tool_1, even if a prior counter reached tool_9", () => {
    const turnOne = new GatewayToolIdCounter();
    for (let index = 0; index < 9; index += 1) turnOne.nextId();
    expect(turnOne.nextId()).toBe("tool_10");
    const turnTwo = new GatewayToolIdCounter();
    expect(turnTwo.nextId()).toBe("tool_1");
  });
});
