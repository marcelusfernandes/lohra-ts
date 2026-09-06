import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerConfiguredMcpServers } from "../src/mcp/index.js";
import {
  connectHttpSession,
  connectSession,
  connectStdioSession,
  defaultSessionFactory,
} from "../src/mcp/session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { MCPServerConfig } from "../src/mcp/config.js";

describe("session connectors -- the mcp SDK is absent in this environment (M1)", () => {
  it("connectStdioSession and connectHttpSession both reject with the 'not installed' message", async () => {
    const config: MCPServerConfig = {
      name: "fix",
      transport: "stdio",
      command: "npx",
      args: [],
      env: {},
    };
    await expect(connectStdioSession(config)).rejects.toThrow(
      "the mcp SDK is not installed; run `npm install @modelcontextprotocol/sdk`",
    );
    await expect(connectHttpSession(config)).rejects.toThrow(
      "the mcp SDK is not installed; run `npm install @modelcontextprotocol/sdk`",
    );
  });

  it("connectSession routes by transport and is injectable (the R4 seam)", async () => {
    const stdioConfig: MCPServerConfig = {
      name: "s",
      transport: "stdio",
      command: "x",
      args: [],
      env: {},
    };
    const httpConfig: MCPServerConfig = {
      name: "h",
      transport: "http",
      url: "https://x",
      args: [],
      env: {},
    };
    const stdioCalls: MCPServerConfig[] = [];
    const httpCalls: MCPServerConfig[] = [];
    const session = {
      listTools: () => Promise.resolve([]),
      callTool: () => Promise.resolve({}),
      close: () => Promise.resolve(),
    };
    await connectSession(stdioConfig, {
      stdio: (c) => {
        stdioCalls.push(c);
        return Promise.resolve(session);
      },
    });
    await connectSession(httpConfig, {
      http: (c) => {
        httpCalls.push(c);
        return Promise.resolve(session);
      },
    });
    expect(stdioCalls).toEqual([stdioConfig]);
    expect(httpCalls).toEqual([httpConfig]);
  });

  it("connectSession rejects an unknown runtime transport instead of routing it to HTTP", async () => {
    const invalid = {
      name: "bad",
      transport: "websocket",
      args: [],
      env: {},
    } as unknown as MCPServerConfig;
    const httpCalls: MCPServerConfig[] = [];
    await expect(
      connectSession(invalid, {
        http: (config) => {
          httpCalls.push(config);
          return Promise.reject(new Error("must not run"));
        },
      }),
    ).rejects.toThrow('MCP transport "websocket" not supported');
    expect(httpCalls).toEqual([]);
  });
});

describe("registerConfiguredMcpServers -- best-effort entrypoint", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lohra-mcp-index-"));
    path = join(dir, "mcp.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("missing file -> null, no manager", async () => {
    const registry = new ToolRegistry();
    await expect(registerConfiguredMcpServers(registry, { configPath: path })).resolves.toBeNull();
  });

  it("empty mcpServers -> null", async () => {
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));
    const registry = new ToolRegistry();
    await expect(registerConfiguredMcpServers(registry, { configPath: path })).resolves.toBeNull();
  });

  it("malformed config -> logged 'ignoring MCP config: ...', returns null, never throws", async () => {
    writeFileSync(path, JSON.stringify({ mcpServers: "nope" }));
    const registry = new ToolRegistry();
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => {
      lines.push(chunk);
      return true;
    };
    try {
      await expect(
        registerConfiguredMcpServers(registry, { configPath: path }),
      ).resolves.toBeNull();
    } finally {
      process.stderr.write = original;
    }
    expect(lines.join("")).toBe("ignoring MCP config: 'mcpServers' must be an object\n");
  });

  it("a configured server connects via the injected session factory and registers its tools", async () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { fix: { command: "npx", args: ["fix"] } } }));
    const registry = new ToolRegistry();
    const manager = await registerConfiguredMcpServers(registry, {
      configPath: path,
      sessionFactory: () =>
        Promise.resolve({
          listTools: () => Promise.resolve([{ name: "echo" }]),
          callTool: () => Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
          close: () => Promise.resolve(),
        }),
    });
    expect(manager).not.toBeNull();
    expect(registry.namesInToolset("mcp-fix")).toEqual(["mcp_fix_echo"]);
    await manager?.shutdown();
    expect(registry.namesInToolset("mcp-fix")).toEqual([]);
  });

  it("falls back to defaultSessionFactory.current when no sessionFactory is passed -- the harness's fixture-injection seam", async () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { fix: { command: "npx" } } }));
    const registry = new ToolRegistry();
    const original = defaultSessionFactory.current;
    defaultSessionFactory.current = () =>
      Promise.resolve({
        listTools: () => Promise.resolve([{ name: "echo" }]),
        callTool: () => Promise.resolve({}),
        close: () => Promise.resolve(),
      });
    try {
      const manager = await registerConfiguredMcpServers(registry, { configPath: path });
      expect(manager).not.toBeNull();
      expect(registry.namesInToolset("mcp-fix")).toEqual(["mcp_fix_echo"]);
    } finally {
      defaultSessionFactory.current = original;
    }
  });
});
