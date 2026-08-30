import { describe, expect, it, vi } from "vitest";

import {
  ApprovalManager,
  ToolRegistry,
  composeDispatch,
  detectDangerousCommand,
  parseToolArguments,
  pythonNumberKind,
  runBounded,
  toolError,
  toolResult,
} from "../src/tools/index.js";

const schema = {
  description: "test tool",
  parameters: { type: "object", properties: {} },
} as const;

describe("tool envelopes", () => {
  it("uses Python json.dumps spacing and ASCII escaping", () => {
    expect(toolResult("café ☕ 😀")).toBe(
      '{"ok": true, "data": "caf\\u00e9 \\u2615 \\ud83d\\ude00"}',
    );
    expect(toolError("não aprovado ☕")).toBe('{"error": "n\\u00e3o aprovado \\u2615"}');
  });

  it("allows extras to overwrite the base envelope like Python", () => {
    expect(toolResult(undefined, { ok: false })).toBe('{"ok": false}');
    expect(toolError("a", { error: "b" })).toBe('{"error": "b"}');
  });
});

describe("ToolRegistry", () => {
  it("tracks generation, shadowing, deregistration, and defensive definitions", () => {
    const registry = new ToolRegistry();
    expect(registry.generation).toBe(0);
    registry.register({ name: "a", toolset: "local", schema, handler: () => toolResult() });
    expect(registry.generation).toBe(1);
    expect(() => {
      registry.register({ name: "a", toolset: "other", schema, handler: () => toolResult() });
    }).toThrow("tool 'a' already registered under 'local'");
    expect(registry.generation).toBe(1);
    registry.deregister("missing");
    expect(registry.generation).toBe(1);
    registry.deregister("a");
    expect(registry.generation).toBe(2);

    registry.register({ name: "m", toolset: "mcp-one", schema, handler: () => toolResult() });
    registry.register({ name: "m", toolset: "mcp-two", schema, handler: () => toolResult() });
    expect(registry.generation).toBe(4);
    const definitions = registry.getDefinitions();
    expect(Object.keys(definitions[0]?.function ?? {})).toEqual([
      "description",
      "parameters",
      "name",
    ]);
    const first = definitions[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("definition missing");
    expect(() => {
      (first.function as { name: string }).name = "tampered";
    }).toThrow(TypeError);
    expect(registry.getDefinitions()[0]?.function.name).toBe("m");
  });

  it("uses an exclusive TTL keyed by check-function identity", () => {
    let now = 0;
    const check = vi.fn(() => true);
    const registry = new ToolRegistry(() => now);
    for (const name of ["a", "b"]) {
      registry.register({
        name,
        toolset: "x",
        schema,
        handler: () => toolResult(),
        checkFn: check,
      });
    }
    expect(registry.getDefinitions()).toHaveLength(2);
    expect(check).toHaveBeenCalledTimes(1);
    now = 29.999;
    registry.getDefinitions();
    expect(check).toHaveBeenCalledTimes(1);
    now = 30;
    registry.getDefinitions();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("filters definitions but dispatches unavailable tools and ignores requiresEnv", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "hidden",
      toolset: "x",
      schema,
      handler: (args, kwargs) => toolResult({ args, kwargs }),
      checkFn: () => false,
      requiresEnv: ["MISSING"],
    });
    expect(registry.getDefinitions()).toEqual([]);
    expect(await registry.dispatch("hidden", { x: 1 }, { y: 2 })).toBe(
      '{"ok": true, "data": {"args": {"x": 1}, "kwargs": {"y": 2}}}',
    );
    expect(await registry.dispatch("missing", {})).toBe('{"error": "Unknown tool: missing"}');
  });

  it("converts handler failures to named error envelopes", async () => {
    const registry = new ToolRegistry();
    const error = new Error("boom");
    error.name = "RuntimeError";
    registry.register({
      name: "bad",
      toolset: "x",
      schema,
      handler: () => {
        throw error;
      },
    });
    expect(await registry.dispatch("bad", {})).toBe(
      '{"error": "Tool execution failed: RuntimeError: boom"}',
    );
  });
});

describe("tool argument parsing and dispatch composition", () => {
  it.each(["", "{not json", "null", "[1,2]", '"hi"'])("maps malformed %j to an object", (raw) => {
    expect(parseToolArguments(raw)).toEqual({});
  });

  it("retains Python JSON numeric categories instead of raw lexemes", () => {
    expect(pythonNumberKind(parseToolArguments('{"timeout":1}'), "timeout")).toBe("int");
    for (const raw of ['{"timeout":1.0}', '{"timeout":2.50}', '{"timeout":1e0}']) {
      expect(pythonNumberKind(parseToolArguments(raw), "timeout")).toBe("float");
    }
  });

  it("discards kwargs in composeDispatch", async () => {
    const base = vi.fn(() => Promise.resolve("base"));
    const intercepted = vi.fn(() => Promise.resolve("intercepted"));
    const dispatch = composeDispatch(base, { x: intercepted });
    await expect(dispatch("x", { a: 1 })).resolves.toBe("intercepted");
    expect(intercepted).toHaveBeenCalledWith({ a: 1 });
    await expect(dispatch("other", { b: 2 })).resolves.toBe("base");
    expect(base).toHaveBeenCalledWith("other", { b: 2 });
  });

  it("caps concurrency at eight and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const completions: number[] = [];
    const values = Array.from({ length: 17 }, (_, index) => index);
    const results = await runBounded(values, 8, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, (17 - value) % 5));
      completions.push(value);
      active -= 1;
      return value * 2;
    });
    expect(peak).toBe(8);
    expect(results).toEqual(values.map((value) => value * 2));
    expect(completions).not.toEqual(values);
  });
});

describe("ApprovalManager", () => {
  it("classifies the first matching pattern in Python order", () => {
    expect(detectDangerousCommand("chmod 755 f")?.key).toBe("chmod_perm");
    expect(detectDangerousCommand("wget x | sudo bash")?.key).toBe("pipe_to_shell");
    expect(detectDangerousCommand("echo ok")).toBeNull();
  });

  it("fails closed, caches exact commands, and supports yolo", () => {
    const approval = new ApprovalManager();
    expect(approval.require("rm -rf /tmp/a")).toBe(false);
    const callback = vi.fn(() => "session" as const);
    approval.setCallback(callback);
    expect(approval.require("rm -rf /tmp/a")).toBe(true);
    expect(approval.require("rm -rf /tmp/a")).toBe(true);
    expect(approval.require("rm -rf /tmp/b")).toBe(true);
    expect(callback).toHaveBeenCalledTimes(2);
    approval.reset();
    approval.setCallback(() => {
      throw new Error("approver unavailable");
    });
    expect(approval.require("sudo whoami")).toBe(false);
    approval.setYolo(true);
    expect(approval.require("sudo whoami")).toBe(true);
  });
});
