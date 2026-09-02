import { describe, expect, it } from "vitest";

import {
  convertMcpSchema,
  deregisterServer,
  mcpToolName,
  registerServerTools,
  wrapCallResult,
} from "../src/mcp/tools.js";
import { toolError, toolResult } from "../src/tools/envelope.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("mcpToolName", () => {
  it("sanitizes both server and tool: lowercase, non-alnum runs -> _, stripped", () => {
    expect(mcpToolName("fix", "echo")).toBe("mcp_fix_echo");
    expect(mcpToolName("fix", "search_docs")).toBe("mcp_fix_search_docs");
    expect(mcpToolName("fix", "Weird-Name!")).toBe("mcp_fix_weird_name");
    expect(mcpToolName("github.com", "search")).toBe("mcp_github_com_search");
    expect(mcpToolName("fix", "Do-Thing")).toBe("mcp_fix_do_thing");
    expect(mcpToolName("fix", "do thing")).toBe("mcp_fix_do_thing");
  });
});

describe("convertMcpSchema", () => {
  it("reads description/inputSchema, dict shape", () => {
    expect(convertMcpSchema({ description: "a good one", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } })).toEqual({
      description: "a good one",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    });
  });

  it("non-dict/absent inputSchema -> empty object schema", () => {
    expect(convertMcpSchema({ description: "bad schema", inputSchema: "not an object" }).parameters).toEqual({
      type: "object",
      properties: {},
    });
    expect(convertMcpSchema({ description: "no schema at all" }).parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("description null/absent -> empty string", () => {
    expect(convertMcpSchema({ description: null }).description).toBe("");
    expect(convertMcpSchema({}).description).toBe("");
  });

  it("kills the silent-description-coercion mutant: truthy non-string descriptions stay raw", () => {
    expect(convertMcpSchema({ description: 123 }).description).toBe(123);
    expect(convertMcpSchema({ description: { source: "mcp" } }).description).toEqual({
      source: "mcp",
    });
    expect(convertMcpSchema({ description: false }).description).toBe("");
  });

  it("key order is description, parameters", () => {
    expect(Object.keys(convertMcpSchema({ description: "x", inputSchema: {} }))).toEqual([
      "description",
      "parameters",
    ]);
  });
});

describe("wrapCallResult", () => {
  it("two text blocks concatenate with no separator", () => {
    expect(
      wrapCallResult({ content: [{ type: "text", text: "part-one " }, { type: "text", text: "part-two" }] }),
    ).toBe(toolResult(undefined, { content: "part-one part-two" }));
  });

  it("non-text block -> [type block] placeholder", () => {
    expect(wrapCallResult({ content: [{ type: "image" }] })).toBe(
      toolResult(undefined, { content: "[image block]" }),
    );
  });

  it("kills JS String spelling: null/booleans use Python placeholder spellings", () => {
    expect(wrapCallResult({ content: [{ type: null }] })).toBe(
      toolResult(undefined, { content: "[None block]" }),
    );
    expect(wrapCallResult({ content: [{ type: true }, { type: false }] })).toBe(
      toolResult(undefined, { content: "[True block][False block]" }),
    );
  });

  it("kills the success-empty mutant: truthy non-string text fails with a cause", () => {
    expect(() => wrapCallResult({ content: [{ type: "text", text: 123 }] })).toThrow(
      /must contain a string/u,
    );
    expect(wrapCallResult({ content: [{ type: "text", text: 0 }] })).toBe(
      toolResult(undefined, { content: "" }),
    );
  });

  it("kills the iterable-object mutant: structurally invalid content fails closed", () => {
    expect(() => wrapCallResult({ content: { a: 1 } })).toThrow(
      "MCP result content must be an array of blocks",
    );
  });

  it("isError with text -> tool_error(text)", () => {
    expect(wrapCallResult({ content: [{ type: "text", text: "boom" }], isError: true })).toBe(
      toolError("boom"),
    );
  });

  it("isError with empty content -> tool_error('MCP tool reported an error')", () => {
    expect(wrapCallResult({ content: [], isError: true })).toBe(
      toolError("MCP tool reported an error"),
    );
  });
});

describe("registerServerTools / deregisterServer", () => {
  it("registers under toolset mcp-{server}, handler routes to callTool with the ORIGINAL name", async () => {
    const registry = new ToolRegistry();
    const calls: { name: string; args: unknown }[] = [];
    registerServerTools(registry, "fix", [{ name: "echo", description: "d", inputSchema: {} }], (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    });
    expect(registry.namesInToolset("mcp-fix")).toEqual(["mcp_fix_echo"]);
    await registry.dispatch("mcp_fix_echo", { q: "x" });
    expect(calls).toEqual([{ name: "echo", args: { q: "x" } }]);
  });

  it("tool with empty/missing name is skipped silently", () => {
    const registry = new ToolRegistry();
    const added = registerServerTools(
      registry,
      "fix",
      [{ name: "", description: "d" }, { description: "no name field" }],
      () => ({}),
    );
    expect(added).toEqual([]);
    expect(registry.namesInToolset("mcp-fix")).toEqual([]);
  });

  it("kills per-tool skip: a truthy non-string name rejects the batch before registry mutation", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registerServerTools(
        registry,
        "bad",
        [{ name: "valid-prefix" }, { name: 123 }, { name: "valid-suffix" }],
        () => ({}),
      ),
    ).toThrow(/truthy non-string tool name/u);
    expect(registry.namesInToolset("mcp-bad")).toEqual([]);
  });

  it("keeps Python's falsy-name behavior while rejecting only truthy wrong types", () => {
    const registry = new ToolRegistry();
    expect(
      registerServerTools(
        registry,
        "fix",
        [{ name: null }, { name: false }, { name: 0 }, { name: [] }, { name: {} }],
        () => ({}),
      ),
    ).toEqual([]);
  });

  it("surfaces non-string text through the public registry error envelope", async () => {
    const registry = new ToolRegistry();
    registerServerTools(registry, "fix", [{ name: "echo" }], () => ({
      content: [{ type: "text", text: 123 }],
    }));
    const envelope = JSON.parse(await registry.dispatch("mcp_fix_echo", {})) as {
      readonly error?: string;
    };
    expect(envelope.error).toMatch(/^Tool execution failed: TypeError: .+/u);
  });

  it("rejects an intra-server sanitized-name collision before publishing any tool", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registerServerTools(
        registry,
        "fix",
        [
          { name: "Do-Thing", description: "first" },
          { name: "do thing", description: "second" },
          { name: "other", description: "third" },
        ],
        () => ({}),
      ),
    ).toThrow("MCP tool name collision: mcp_fix_do_thing");
    expect(registry.namesInToolset("mcp-fix")).toEqual([]);
  });

  it("cross-toolset collision with a builtin: MCP tool skipped, builtin intact", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "mcp_fix_file",
      toolset: "builtin",
      schema: { description: "the real one", parameters: { type: "object", properties: {} } },
      handler: () => toolResult("builtin"),
    });
    const added = registerServerTools(registry, "fix", [{ name: "file", description: "mcp one" }], () => ({}));
    expect(added).toEqual([]);
    expect(registry.namesInToolset("mcp-fix")).toEqual([]);
    expect(registry.namesInToolset("builtin")).toEqual(["mcp_fix_file"]);
  });

  it("does not relabel an unexpected registry failure as a shadow warning", () => {
    class ExplodingRegistry extends ToolRegistry {
      override registerBatch(): void {
        throw new RangeError("structured clone exploded");
      }
    }

    expect(() =>
      registerServerTools(
        new ExplodingRegistry(),
        "fix",
        [{ name: "echo", description: "d" }],
        () => ({}),
      ),
    ).toThrow(new RangeError("structured clone exploded"));
  });

  it("cross-server MCP collision is rejected and preserves the first owner's registry", () => {
    const registry = new ToolRegistry();
    registerServerTools(registry, "github.com", [{ name: "search", description: "A" }], () => "A");
    expect(() =>
      registerServerTools(registry, "github_com", [{ name: "search", description: "B" }], () => "B"),
    ).toThrow("MCP tool name collision: mcp_github_com_search");
    expect(registry.namesInToolset("mcp-github.com")).toEqual(["mcp_github_com_search"]);
    expect(registry.namesInToolset("mcp-github_com")).toEqual([]);

    deregisterServer(registry, "github.com");
    expect(registry.namesInToolset("mcp-github.com")).toEqual([]);
  });

  it("deregisterServer removes only the named server's own toolset", () => {
    const registry = new ToolRegistry();
    registerServerTools(registry, "fix", [{ name: "echo" }], () => ({}));
    registerServerTools(registry, "other", [{ name: "thing" }], () => ({}));
    deregisterServer(registry, "fix");
    expect(registry.namesInToolset("mcp-fix")).toEqual([]);
    expect(registry.namesInToolset("mcp-other")).toEqual(["mcp_other_thing"]);
  });
});
