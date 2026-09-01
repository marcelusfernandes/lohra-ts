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

  it("disabled follows Python JSON truthiness and therefore fails closed for truthy non-booleans", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          number: { command: "npx", disabled: 1 },
          yes: { command: "npx", disabled: "yes" },
          misleading: { command: "npx", disabled: "false" },
          list: { command: "npx", disabled: [false] },
          object: { command: "npx", disabled: { reason: "operator choice" } },
        },
      }),
    );
    expect(loadMcpConfig(path)).toEqual([]);
  });

  it("disabled preserves Python's falsy JSON values", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          falseBoolean: { command: "npx", disabled: false },
          zero: { command: "npx", disabled: 0 },
          emptyString: { command: "npx", disabled: "" },
          nullValue: { command: "npx", disabled: null },
          emptyList: { command: "npx", disabled: [] },
          emptyObject: { command: "npx", disabled: {} },
        },
      }),
    );
    expect(loadMcpConfig(path).map((config) => config.name)).toEqual([
      "falseBoolean",
      "zero",
      "emptyString",
      "nullValue",
      "emptyList",
      "emptyObject",
    ]);
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

  it("kills silent filtering: preserves Python container construction for hostile args/env", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          chars: { command: "npx", args: "abc", env: { A: 1 } },
          values: { command: "npx", args: [1, 2], env: { FLAG: true } },
        },
      }),
    );
    expect(loadMcpConfig(path)).toEqual([
      {
        name: "chars",
        transport: "stdio",
        command: "npx",
        args: ["a", "b", "c"],
        env: { A: 1 },
      },
      {
        name: "values",
        transport: "stdio",
        command: "npx",
        args: [1, 2],
        env: { FLAG: true },
      },
    ]);
  });

  it("kills accepting execution-boundary shapes: truthy non-string url/command abort the set", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { good: { command: "npx" }, bad: { url: 123 } },
      }),
    );
    expect(() => loadMcpConfig(path)).toThrow("server 'bad' field 'url' must be a string");

    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { good: { command: "npx" }, bad: { command: ["npx", "server"] } },
      }),
    );
    expect(() => loadMcpConfig(path)).toThrow("server 'bad' field 'command' must be a string");
  });

  it("a config error aborts the whole set -- one bad server invalidates all", () => {
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { fix: { command: "npx" }, bad: {} } }),
    );
    expect(() => loadMcpConfig(path)).toThrow("server 'bad' needs a 'command' (stdio) or 'url' (http)");
  });
});
