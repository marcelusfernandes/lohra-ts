import { describe, expect, it, vi } from "vitest";

import { MCPManager } from "../src/mcp/manager.js";
import type { MCPServerConfig } from "../src/mcp/config.js";
import type { MCPSession } from "../src/mcp/session.js";
import { ToolRegistry } from "../src/tools/registry.js";

function config(name: string, overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { name, transport: "stdio", command: "npx", args: [], env: {}, ...overrides };
}

function fakeSession(
  tools: readonly unknown[],
  overrides: Partial<MCPSession> = {},
): MCPSession {
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
  process.stderr.write = ((chunk: string) => {
    lines.push(chunk);
    return true;
  });
  return { lines, restore: () => (process.stderr.write = original) };
}

describe("MCPManager.connectAll", () => {
  it("registers a server's tools and isolates one server's failure from the rest", async () => {
    const registry = new ToolRegistry();
    const good = config("fix");
    const bad = config("broken");
    const factory = vi.fn((cfg: MCPServerConfig) => {
      if (cfg.name === "broken") return Promise.reject(new Error("no such server"));
      return Promise.resolve(fakeSession([{ name: "echo" }]));
    });
    const manager = new MCPManager(registry, factory);
    const capture = captureStderr();
    try {
      await manager.connectAll([bad, good]);
    } finally {
      capture.restore();
    }
    expect(registry.namesInToolset("mcp-fix")).toEqual(["mcp_fix_echo"]);
    expect(registry.namesInToolset("mcp-broken")).toEqual([]);
    expect(capture.lines.join("")).toBe("MCP server 'broken' failed to connect: no such server\n");
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
    const capture = captureStderr();
    try {
      await manager.connectAll([config("bad")]);
    } finally {
      capture.restore();
    }
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(capture.lines.join("")).toBe("MCP server 'bad' failed to connect: cannot list\n");
  });

  it("rejects an invalid-name batch atomically, closes it, and still connects a valid neighbor", async () => {
    const registry = new ToolRegistry();
    const badClose = vi.fn(() => Promise.resolve());
    const factory = (cfg: MCPServerConfig) =>
      Promise.resolve(
        cfg.name === "bad"
          ? fakeSession([{ name: "prefix" }, { name: 123 }, { name: "suffix" }], {
              close: badClose,
            })
          : fakeSession([{ name: "ok" }]),
      );
    const manager = new MCPManager(registry, factory);
    const capture = captureStderr();
    try {
      await manager.connectAll([config("bad"), config("good")]);
    } finally {
      capture.restore();
    }
    expect(registry.namesInToolset("mcp-bad")).toEqual([]);
    expect(registry.namesInToolset("mcp-good")).toEqual(["mcp_good_ok"]);
    expect(badClose).toHaveBeenCalledTimes(1);
    expect(capture.lines.join("")).toMatch(
      /^MCP server 'bad' failed to connect: MCP server 'bad' returned a truthy non-string tool name: 123\n$/u,
    );
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
    expect(capture.lines.join("")).toBe("error closing MCP session 'flaky': stuck\n");
  });
});
