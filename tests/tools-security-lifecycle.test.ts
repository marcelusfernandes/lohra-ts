import { describe, expect, it, vi } from "vitest";

import {
  childToolDefinitions,
  createChildDispatch,
  toolError,
  toolResult,
  wrapToolDispatch,
  type ToolDefinition,
  type ToolLifecycleEvent,
} from "../src/tools/index.js";

const definition = (name: string): ToolDefinition => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object" } },
});

describe("child tool hardening", () => {
  it("uses a closed allow-list for definitions, including fabricated MCP tools", () => {
    const all = [
      "read_file",
      "write_file",
      "terminal",
      "web_fetch",
      "web_search",
      "memory",
      "mcp-secret-exfil",
    ].map(definition);
    expect(childToolDefinitions(all).map((item) => item.function.name)).toEqual([
      "read_file",
      "write_file",
      "terminal",
      "web_fetch",
      "web_search",
    ]);
  });

  it("rejects unknown names and non-string terminal commands before base dispatch", async () => {
    const base = vi.fn(() => Promise.resolve(toolResult("base")));
    const dispatch = createChildDispatch(base);
    await expect(dispatch("mcp-secret-exfil", {})).resolves.toBe(
      toolError("Unknown tool: mcp-secret-exfil"),
    );
    await expect(dispatch("terminal", { command: ["sudo", "x"] })).resolves.toBe(
      toolError("command was not approved by the user", { command: ["sudo", "x"] }),
    );
    expect(base).not.toHaveBeenCalled();
    await expect(dispatch("read_file", { path: "x" })).resolves.toBe(toolResult("base"));
    expect(base).toHaveBeenCalledTimes(1);
  });
});

describe("tool lifecycle wrapper", () => {
  it("emits Python-shaped start/complete pairs with session-local ids", async () => {
    const events: ToolLifecycleEvent[] = [];
    const base = vi.fn((_name: string, args: Readonly<Record<string, unknown>>) =>
      Promise.resolve(toolResult(args)),
    );
    const dispatch = wrapToolDispatch(base, (event) => events.push(event));
    await expect(dispatch("x", { text: "café", n: 1 })).resolves.toBe(
      '{"ok": true, "data": {"text": "caf\\u00e9", "n": 1}}',
    );
    await dispatch("y", {});
    expect(events).toEqual([
      {
        type: "tool.start",
        payload: {
          tool_id: "tool_1",
          name: "x",
          args_text: '{"text": "caf\\u00e9", "n": 1}',
        },
      },
      {
        type: "tool.complete",
        payload: {
          tool_id: "tool_1",
          name: "x",
          args: { text: "café", n: 1 },
          result: '{"ok": true, "data": {"text": "caf\\u00e9", "n": 1}}',
        },
      },
      {
        type: "tool.start",
        payload: { tool_id: "tool_2", name: "y", args_text: "{}" },
      },
      {
        type: "tool.complete",
        payload: {
          tool_id: "tool_2",
          name: "y",
          args: {},
          result: '{"ok": true, "data": {}}',
        },
      },
    ]);
  });

  it("emits no completion when base throws", async () => {
    const events: ToolLifecycleEvent[] = [];
    const dispatch = wrapToolDispatch(
      () => Promise.reject(new Error("boom")),
      (event) => events.push(event),
    );
    await expect(dispatch("bad", {})).rejects.toThrow("boom");
    expect(events.map((event) => event.type)).toEqual(["tool.start"]);
  });

  it("fails closed when the sink throws before execution", async () => {
    const base = vi.fn(() => Promise.resolve(toolResult()));
    const dispatch = wrapToolDispatch(base, () => {
      throw new Error("sink failed");
    });
    await expect(dispatch("x", {})).rejects.toThrow("sink failed");
    expect(base).not.toHaveBeenCalled();
  });
});
