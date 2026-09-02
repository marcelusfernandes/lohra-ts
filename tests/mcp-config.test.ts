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
    expect(() => loadMcpConfig(path)).toThrow(
      new RegExp(`^could not parse ${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}: `),
    );
  });

  it("mcpServers non-object throws 'mcpServers' must be an object", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: "nope" }));
    expect(() => loadMcpConfig(path)).toThrow("'mcpServers' must be an object");
  });

  it("server without command/url throws named error", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { bad: {} } }));
    expect(() => loadMcpConfig(path)).toThrow(
      "server 'bad' needs a 'command' (stdio) or 'url' (http)",
    );
  });

  it("server spec non-object throws named error", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { bad: "nope" } }));
    expect(() => loadMcpConfig(path)).toThrow("server 'bad' must be an object");
  });

  it("disabled: true is skipped", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          off: { command: "npx", disabled: true },
          fix: { command: "npx", args: ["fix"] },
        },
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
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.com/" } } }),
    );
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
      {
        name: "fix",
        transport: "stdio",
        command: "npx",
        args: ["-y", "fix-server"],
        env: { TOKEN: "x" },
      },
    ]);
  });

  it("kills silent filtering: preserves Python container construction for hostile args/env", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          chars: {
            command: "npx",
            args: "abc",
            env: [
              [null, "nil"],
              ["A", 1],
              ["B", "x"],
              ["__proto__", { polluted: true }],
            ],
          },
          values: { command: "npx", args: [1, 2], env: { FLAG: true } },
        },
      }),
    );
    const configs = loadMcpConfig(path);
    expect(configs[0]).toMatchObject({
      name: "chars",
      transport: "stdio",
      command: "npx",
      args: ["a", "b", "c"],
      env: { null: "nil", A: 1, B: "x" },
    });
    const hostileEnv = configs[0]?.env;
    expect(hostileEnv).toBeDefined();
    expect(Object.getPrototypeOf(hostileEnv)).toBeNull();
    expect(Object.hasOwn(hostileEnv ?? {}, "__proto__")).toBe(true);
    expect(hostileEnv?.["__proto__"]).toEqual({ polluted: true });
    expect(hostileEnv?.["polluted"]).toBeUndefined();
    expect(JSON.stringify(hostileEnv)).toBe(
      '{"null":"nil","A":1,"B":"x","__proto__":{"polluted":true}}',
    );
    expect(configs[1]).toEqual({
      name: "values",
      transport: "stdio",
      command: "npx",
      args: [1, 2],
      env: { FLAG: true },
    });
  });

  it("rejects env keys outside the representable T19 mapping domain with an explicit cause", () => {
    const rejectedKeys: readonly [string, unknown][] = [
      ["boolean", true],
      ["integer", 1],
      ["float", 1.5],
      ["array", ["nested"]],
      ["object", { nested: true }],
    ];
    for (const [label, key] of rejectedKeys) {
      writeFileSync(
        path,
        JSON.stringify({ mcpServers: { fix: { command: "npx", env: [[key, label]] } } }),
      );
      expect(() => loadMcpConfig(path), label).toThrow(
        "server 'fix' field 'env' entry 0 key must be a non-ambiguous string or null",
      );
    }
  });

  it("rejects canonical array-index strings but accepts neighboring non-index strings", () => {
    for (const key of ["0", "1", "4294967294"]) {
      writeFileSync(
        path,
        JSON.stringify({ mcpServers: { fix: { command: "npx", env: [[key, "x"]] } } }),
      );
      expect(() => loadMcpConfig(path), key).toThrow(
        `server 'fix' field 'env' entry 0 key '${key}' is a canonical array-index string`,
      );
    }

    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          fix: {
            command: "npx",
            env: [
              ["4294967295", "max-plus-one"],
              ["00", "leading-zero"],
            ],
          },
        },
      }),
    );
    const env = loadMcpConfig(path)[0]?.env;
    expect(Object.getPrototypeOf(env)).toBeNull();
    expect(JSON.stringify(env)).toBe('{"4294967295":"max-plus-one","00":"leading-zero"}');

    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { fix: { command: "npx", env: { 0: "object-index" } } } }),
    );
    expect(() => loadMcpConfig(path)).toThrow(
      "server 'fix' field 'env' key '0' is a canonical array-index string",
    );
  });

  it("rejects duplicate env keys after null coercion instead of collapsing them", () => {
    for (const entries of [
      [
        [null, "none"],
        ["null", "string"],
      ],
      [
        ["A", 1],
        ["A", 2],
      ],
    ]) {
      writeFileSync(
        path,
        JSON.stringify({ mcpServers: { fix: { command: "npx", env: entries } } }),
      );
      expect(() => loadMcpConfig(path)).toThrow(
        "server 'fix' field 'env' entry 1 collides after key coercion",
      );
    }
  });

  it("rejects args outside the versioned string/list domain", () => {
    for (const args of [{ A: 1 }, 1, true]) {
      writeFileSync(path, JSON.stringify({ mcpServers: { fix: { command: "npx", args } } }));
      expect(() => loadMcpConfig(path)).toThrow(
        "server 'fix' field 'args' must be a string or array",
      );
    }
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
    writeFileSync(path, JSON.stringify({ mcpServers: { fix: { command: "npx" }, bad: {} } }));
    expect(() => loadMcpConfig(path)).toThrow(
      "server 'bad' needs a 'command' (stdio) or 'url' (http)",
    );
  });
});
