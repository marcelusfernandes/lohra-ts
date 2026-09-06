import { describe, expect, it, vi } from "vitest";

import { MCPManager } from "../src/mcp/manager.js";
import type { MCPServerConfig } from "../src/mcp/config.js";
import type { MCPSession } from "../src/mcp/session.js";
import { ToolRegistry } from "../src/tools/registry.js";

function config(name: string, overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { name, transport: "stdio", command: "npx", args: [], env: {}, ...overrides };
}

function fakeSession(tools: readonly unknown[], overrides: Partial<MCPSession> = {}): MCPSession {
  return {
    listTools: () => Promise.resolve(tools),
    callTool: () => Promise.resolve({}),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

function captureStderr(): { readonly lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string) => {
    lines.push(chunk);
    return true;
  };
  return { lines, restore: () => (process.stderr.write = original) };
}

describe("MCPManager.connectAll", () => {
  it("rolls back the whole call and closes staged sessions when a later server fails", async () => {
    const registry = new ToolRegistry();
    const good = config("fix");
    const bad = config("broken");
    const goodClose = vi.fn(() => Promise.resolve());
    const factory = vi.fn((cfg: MCPServerConfig) => {
      if (cfg.name === "broken") return Promise.reject(new Error("no such server"));
      return Promise.resolve(fakeSession([{ name: "echo" }], { close: goodClose }));
    });
    const manager = new MCPManager(registry, factory);
    await expect(manager.connectAll([good, bad])).rejects.toThrow("no such server");
    expect(registry.namesInToolset("mcp-fix")).toEqual([]);
    expect(registry.namesInToolset("mcp-broken")).toEqual([]);
    expect(goodClose).toHaveBeenCalledTimes(1);
  });

  it("a session that fails list_tools closes without leaking, and gets the SAME 'failed to connect' message a connect failure would (M12)", async () => {
    const registry = new ToolRegistry();
    const closeSpy = vi.fn(() => Promise.resolve());
    const factory = () =>
      Promise.resolve(
        fakeSession([], {
          listTools: () => Promise.reject(new Error("cannot list")),
          close: closeSpy,
        }),
      );
    const manager = new MCPManager(registry, factory);
    await expect(manager.connectAll([config("bad")])).rejects.toThrow("cannot list");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid-name batch atomically and closes every staged neighbor", async () => {
    const registry = new ToolRegistry();
    const badClose = vi.fn(() => Promise.resolve());
    const goodClose = vi.fn(() => Promise.resolve());
    const factory = (cfg: MCPServerConfig) =>
      Promise.resolve(
        cfg.name === "bad"
          ? fakeSession([{ name: "prefix" }, { name: 123 }, { name: "suffix" }], {
              close: badClose,
            })
          : fakeSession([{ name: "ok" }], { close: goodClose }),
      );
    const manager = new MCPManager(registry, factory);
    await expect(manager.connectAll([config("good"), config("bad")])).rejects.toThrow(
      /truthy non-string tool name/u,
    );
    expect(registry.namesInToolset("mcp-bad")).toEqual([]);
    expect(registry.namesInToolset("mcp-good")).toEqual([]);
    expect(badClose).toHaveBeenCalledTimes(1);
    expect(goodClose).toHaveBeenCalledTimes(1);
  });

  it("rejects a sanitized cross-server collision in either declaration order with no partial publication", async () => {
    for (const names of [
      ["github.com", "github_com"],
      ["github_com", "github.com"],
    ] as const) {
      const registry = new ToolRegistry();
      const closes = new Map(names.map((name) => [name, vi.fn(() => Promise.resolve())]));
      const manager = new MCPManager(registry, (cfg) => {
        const close = closes.get(cfg.name as (typeof names)[number]);
        if (close === undefined) throw new Error("unexpected fixture server");
        return Promise.resolve(fakeSession([{ name: "search" }], { close }));
      });

      await expect(manager.connectAll(names.map((name) => config(name)))).rejects.toMatchObject({
        cause: "MCP_TOOL_NAME_COLLISION",
        message: "MCP tool name collision: mcp_github_com_search",
      });
      expect(registry.namesInToolset(`mcp-${names[0]}`)).toEqual([]);
      expect(registry.namesInToolset(`mcp-${names[1]}`)).toEqual([]);
      expect(closes.get(names[0])).toHaveBeenCalledTimes(1);
      expect(closes.get(names[1])).toHaveBeenCalledTimes(1);
    }
  });
});

describe("MCPManager.refresh", () => {
  it("is a no-op for an unconnected server", async () => {
    const registry = new ToolRegistry();
    const manager = new MCPManager(registry, () => Promise.reject(new Error("never called")));
    await expect(manager.refresh("ghost")).resolves.toBeUndefined();
  });

  it("nuke-and-repave: deregisters the old set, re-lists, re-registers", async () => {
    const registry = new ToolRegistry();
    let call = 0;
    const factory = () =>
      Promise.resolve(
        fakeSession([{ name: "one" }], {
          listTools: () => {
            call += 1;
            return Promise.resolve(call === 1 ? [{ name: "one" }] : [{ name: "two" }]);
          },
        }),
      );
    const manager = new MCPManager(registry, factory);
    await manager.connectAll([config("fix")]);
    expect(registry.namesInToolset("mcp-fix")).toEqual(["mcp_fix_one"]);
    await manager.refresh("fix");
    expect(registry.namesInToolset("mcp-fix")).toEqual(["mcp_fix_two"]);
  });

  it("preserves the old toolset when refresh validation fails", async () => {
    const registry = new ToolRegistry();
    let call = 0;
    const manager = new MCPManager(registry, () =>
      Promise.resolve(
        fakeSession([], {
          listTools: () => {
            call += 1;
            return Promise.resolve(
              call === 1 ? [{ name: "stable" }] : [{ name: "Do-Thing" }, { name: "do thing" }],
            );
          },
        }),
      ),
    );
    await manager.connectAll([config("fix")]);

    await expect(manager.refresh("fix")).rejects.toMatchObject({
      cause: "MCP_TOOL_NAME_COLLISION",
    });
    expect(registry.namesInToolset("mcp-fix")).toEqual(["mcp_fix_stable"]);
  });
});

describe("MCPManager.shutdown", () => {
  it("deregisters and closes every session; one close failure does not block the others", async () => {
    const registry = new ToolRegistry();
    const factory = (cfg: MCPServerConfig) =>
      Promise.resolve(
        fakeSession([{ name: "t" }], {
          close: () =>
            cfg.name === "flaky" ? Promise.reject(new Error("stuck")) : Promise.resolve(),
        }),
      );
    const manager = new MCPManager(registry, factory);
    await manager.connectAll([config("flaky"), config("fine")]);
    const capture = captureStderr();
    try {
      await manager.shutdown();
    } finally {
      capture.restore();
    }
    expect(registry.namesInToolset("mcp-flaky")).toEqual([]);
    expect(registry.namesInToolset("mcp-fine")).toEqual([]);
    expect(capture.lines.join("")).toBe('error closing MCP session "flaky": stuck\n');
  });
});
