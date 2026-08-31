import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMcpConfig, MCPConfigError } from "../src/mcp/config.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lohra-mcp-config-"));
  path = join(dir, "mcp.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadMcpConfig", () => {
  it("missing file -> []", () => {
    expect(loadMcpConfig(path)).toEqual([]);
  });

  it("empty mcpServers -> []", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));
    expect(loadMcpConfig(path)).toEqual([]);
  });

  it("malformed JSON throws MCPConfigError with a 'could not parse <path>: ...' prefix", () => {
    writeFileSync(path, "{not json");
    expect(() => loadMcpConfig(path)).toThrow(MCPConfigError);
    expect(() => loadMcpConfig(path)).toThrow(new RegExp(`^could not parse ${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}: `));
  });

  it("mcpServers non-object throws 'mcpServers' must be an object", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: "nope" }));
    expect(() => loadMcpConfig(path)).toThrow("'mcpServers' must be an object");
  });

  it("server without command/url throws named error", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { bad: {} } }));
    expect(() => loadMcpConfig(path)).toThrow("server 'bad' needs a 'command' (stdio) or 'url' (http)");
  });

  it("server spec non-object throws named error", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { bad: "nope" } }));
    expect(() => loadMcpConfig(path)).toThrow("server 'bad' must be an object");
  });

  it("disabled: true is skipped", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { off: { command: "npx", disabled: true }, fix: { command: "npx", args: ["fix"] } },
      }),
    );
    const configs = loadMcpConfig(path);
    expect(configs).toHaveLength(1);
    expect(configs[0]?.name).toBe("fix");
  });

  it("url present -> transport http, url preserved", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.com/" } } }));
    expect(loadMcpConfig(path)).toEqual([
      { name: "remote", transport: "http", args: [], env: {}, url: "https://mcp.example.com/" },
    ]);
  });

  it("command present -> transport stdio, command+args+env preserved", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { fix: { command: "npx", args: ["-y", "fix-server"], env: { TOKEN: "x" } } },
      }),
    );
    expect(loadMcpConfig(path)).toEqual([
      { name: "fix", transport: "stdio", command: "npx", args: ["-y", "fix-server"], env: { TOKEN: "x" } },
    ]);
  });

  it("a config error aborts the whole set -- one bad server invalidates all", () => {
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { fix: { command: "npx" }, bad: {} } }),
    );
    expect(() => loadMcpConfig(path)).toThrow("server 'bad' needs a 'command' (stdio) or 'url' (http)");
  });
});
