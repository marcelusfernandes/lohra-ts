#!/usr/bin/env node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { loadMcpConfig } from "../../../src/mcp/config.js";
import {
  deregisterServer,
  MCPManager,
  registerServerTools,
  type MCPSession,
  type MCPServerConfig,
} from "../../../src/mcp/index.js";
import { MCPToolNameCollisionError } from "../../../src/mcp/tools.js";
import { createBuiltinRegistry, ToolRegistry } from "../../../src/tools/index.js";
import {
  assertTcpPortsClosed,
  root,
  runChat,
  runGuards,
  type ScenarioResult,
  writeSuiteEvidence,
} from "./harness.js";
import { type McpFixture } from "./fixtures.js";

const guards = runGuards();

async function scenario(
  id: string,
  assertions: readonly (number | string)[],
  tier: string,
  body: () =>
    | Promise<Omit<ScenarioResult, "id" | "assertions" | "tier">>
    | Omit<ScenarioResult, "id" | "assertions" | "tier">,
): Promise<ScenarioResult> {
  try {
    await assertTcpPortsClosed();
    return { id, assertions, tier, ...(await body()) };
  } catch (error) {
    return {
      id,
      assertions,
      tier,
      pass: false,
      projection: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function config(name: string): MCPServerConfig {
  return { name, transport: "stdio", command: "/bin/echo", args: [], env: {} };
}

function sourceMatches(directory: string, needle: string): readonly string[] {
  const matches: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...sourceMatches(path, needle));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.includes(needle)) {
        matches.push(`${relative(root, path)}:${String(index + 1)}:${line.trim()}`);
      }
    }
  }
  return matches;
}

const results: ScenarioResult[] = [];

results.push(
  await scenario("t19-shadow-deregister-orphan", [15, 16, 22], "process-ts supporting", () => {
    const registry = new ToolRegistry();
    const tool = [{ name: "search", description: "d", inputSchema: { type: "object" } }];
    registerServerTools(registry, "github.com", tool, () => ({ content: [], isError: false }));
    let collision: unknown;
    try {
      registerServerTools(registry, "github_com", tool, () => ({ content: [], isError: false }));
    } catch (error) {
      collision = error;
    }
    const before = {
      existingOwner: registry.namesInToolset("mcp-github.com"),
      rejectedOwner: registry.namesInToolset("mcp-github_com"),
    };
    deregisterServer(registry, "github_com");
    const afterRejectedOwnerDeregister = registry.namesInToolset("mcp-github.com");
    deregisterServer(registry, "github.com");
    const afterExistingOwnerDeregister = registry.namesInToolset("mcp-github.com");

    const rawToolsetRegistry = new ToolRegistry();
    registerServerTools(
      rawToolsetRegistry,
      "My Server!",
      [{ name: "Weird-Name!", description: "raw toolset proof" }],
      () => ({ content: [], isError: false }),
    );
    const rawToolsetProof = {
      raw: rawToolsetRegistry.namesInToolset("mcp-My Server!"),
      sanitized: rawToolsetRegistry.namesInToolset("mcp-my_server"),
    };
    return {
      pass:
        collision instanceof MCPToolNameCollisionError &&
        Object.getOwnPropertyDescriptor(collision, "cause")?.value === "MCP_TOOL_NAME_COLLISION" &&
        collision.message === "MCP tool name collision: mcp_github_com_search" &&
        JSON.stringify(before.existingOwner) === JSON.stringify(["mcp_github_com_search"]) &&
        before.rejectedOwner.length === 0 &&
        JSON.stringify(afterRejectedOwnerDeregister) ===
          JSON.stringify(["mcp_github_com_search"]) &&
        afterExistingOwnerDeregister.length === 0 &&
        JSON.stringify(rawToolsetProof.raw) === JSON.stringify(["mcp_my_server_weird_name"]) &&
        rawToolsetProof.sanitized.length === 0,
      projection: {
        collision:
          collision instanceof MCPToolNameCollisionError
            ? { cause: collision.cause, message: collision.message }
            : null,
        before,
        afterRejectedOwnerDeregister,
        afterExistingOwnerDeregister,
        rawToolsetProof,
        publicOwnerProof: "t19-cross-server-shadow-last-wins (superseded by T22 D3)",
        publicNamingProof: "t19-naming-sanitization",
        t22AtomicCollision: true,
      },
      note: "T22 D3 supersedes last-wins: a separate registration call preserves the existing owner, publishes nothing for the rejected owner, and deregistration remains ownership-scoped.",
    };
  }),
);

results.push(
  await scenario("t19-refresh-nuke-and-repave", [17], "process-ts non-principal", async () => {
    const registry = new ToolRegistry();
    let lists = 0;
    const session: MCPSession = {
      listTools: () => {
        lists += 1;
        return Promise.resolve(lists === 1 ? [{ name: "one" }] : [{ name: "two" }]);
      },
      callTool: () => Promise.resolve({ content: [], isError: false }),
      close: () => Promise.resolve(),
    };
    const manager = new MCPManager(registry, () => Promise.resolve(session));
    await manager.connectAll([config("fix")]);
    const before = registry.namesInToolset("mcp-fix");
    await manager.refresh("fix");
    const after = registry.namesInToolset("mcp-fix");
    await manager.shutdown();
    return {
      pass:
        JSON.stringify(before) === JSON.stringify(["mcp_fix_one"]) &&
        JSON.stringify(after) === JSON.stringify(["mcp_fix_two"]) &&
        lists === 2,
      projection: { before, after, lists, productCaller: false },
      note: "No public traversal exists; this evidence is explicitly non-principal per contract decision 4.",
    };
  }),
);

results.push(
  await scenario("t19-refresh-no-product-caller", [17, 18, "18a"], "code non-principal", () => {
    // Repository-native traversal: no caller PATH/tooling dependency. Any
    // filesystem failure throws and is surfaced by scenario() as a hard fail.
    const matches = sourceMatches(join(root, "src"), ".refresh(");
    return {
      pass: matches.length === 0,
      projection: {
        productCallers: matches,
        liveSdkPath: "NOT_MEASURED",
        realSubprocessSpawned: false,
        timeouts: "CODE_ONLY_NOT_PROVEN",
      },
      note: "Static negative only; it never promotes stdio/http SDK behavior to covered or green.",
    };
  }),
);

results.push(
  await scenario("t19-builtin-collision-dead-code", [19], "code + chat-bilateral", async () => {
    const registry = createBuiltinRegistry();
    const builtins = registry.getDefinitions().map((entry) => entry.function.name);
    const mcpPrefixedBuiltins = builtins.filter((name) => name.startsWith("mcp_"));
    registerServerTools(
      registry,
      "fix",
      [{ name: "file", description: "would collide only with a builtin named mcp_fix_file" }],
      () => ({ content: [], isError: false }),
    );
    const mechanismRegisters = registry.namesInToolset("mcp-fix");
    const fixture: McpFixture = {
      servers: {
        fix: {
          tools: [
            {
              name: "file",
              description: "would collide only with a builtin named mcp_fix_file",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      },
    };
    const mcpConfig = { mcpServers: { fix: { command: "/bin/echo" } } };
    const oracle = await runChat("oracle", {
      tag: "builtin-collision-oracle",
      mcpConfig,
      fixture,
    });
    const candidate = await runChat("candidate", {
      tag: "builtin-collision-candidate",
      mcpConfig,
      fixture,
    });
    const names = (records: typeof oracle.records) =>
      (records.find((record) => record.role === "parent")?.toolNames ?? []).filter((name) =>
        name.startsWith("mcp_"),
      );
    const oracleMcp = names(oracle.records);
    const candidateMcp = names(candidate.records);
    return {
      pass:
        builtins.length === 24 &&
        mcpPrefixedBuiltins.length === 0 &&
        JSON.stringify(mechanismRegisters) === JSON.stringify(["mcp_fix_file"]) &&
        JSON.stringify(oracleMcp) === JSON.stringify(["mcp_fix_file"]) &&
        JSON.stringify(candidateMcp) === JSON.stringify(oracleMcp),
      projection: {
        builtinCount: builtins.length,
        mcpPrefixedBuiltins,
        mechanismRegisters,
        oracleMcp,
        candidateMcp,
        activeProtection: false,
      },
    };
  }),
);

results.push(
  await scenario("t19-hostile-config-domain-guards", [34], "process-ts supporting", () => {
    const directory = mkdtempSync(join(tmpdir(), "lohra-t19-config-domain-"));
    const configPath = join(directory, "mcp.json");
    const load = (spec: Readonly<Record<string, unknown>>) => {
      writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { fix: { command: "fixture", ...spec } } }),
      );
      return loadMcpConfig(configPath);
    };
    try {
      const accepted = load({
        args: "ab",
        env: [
          [null, "nil"],
          ["A", 1],
          ["__proto__", { safe: true }],
        ],
      })[0];
      const acceptedEnv = accepted?.env;
      const rejected = [];
      for (const [name, spec] of [
        ["args-object", { args: { A: 1 } }],
        ["boolean-key", { env: [[true, "x"]] }],
        ["number-key", { env: [[1, "x"]] }],
        ["float-key", { env: [[1.5, "x"]] }],
        ["array-key", { env: [[["nested"], "x"]] }],
        ["object-key", { env: [[{ nested: true }, "x"]] }],
        ["canonical-index", { env: [["1", "x"]] }],
        [
          "duplicate-after-null",
          {
            env: [
              [null, "none"],
              ["null", "string"],
            ],
          },
        ],
      ] as const) {
        try {
          load(spec);
          rejected.push({ name, cause: null });
        } catch (error) {
          rejected.push({ name, cause: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        pass:
          accepted?.args.join("") === "ab" &&
          acceptedEnv !== undefined &&
          Object.getPrototypeOf(acceptedEnv) === null &&
          Object.hasOwn(acceptedEnv, "__proto__") &&
          acceptedEnv["polluted"] === undefined &&
          JSON.stringify(acceptedEnv) === '{"null":"nil","A":1,"__proto__":{"safe":true}}' &&
          rejected.every((entry) => typeof entry.cause === "string" && entry.cause.length > 0),
        projection: {
          accepted: {
            args: accepted?.args,
            envJson: JSON.stringify(acceptedEnv),
            nullPrototype: acceptedEnv !== undefined && Object.getPrototypeOf(acceptedEnv) === null,
            protoOwnProperty: Object.hasOwn(acceptedEnv ?? {}, "__proto__"),
            prototypePolluted: acceptedEnv?.["polluted"] !== undefined,
          },
          rejected,
          principalProof: "t19-hostile-inputs-oracle-aligned + t19-hostile-inputs-fail-closed",
        },
        note: "Supporting mutation-kill surface for contract-v4 mapping guards; principal evidence remains chat-bilateral.",
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }),
);

const evidence = writeSuiteEvidence("t19-process-and-code", guards, results);
process.stdout.write(
  `${JSON.stringify({
    suite: evidence["suite"],
    scenarios: evidence["scenarios"],
    failures: evidence["failures"],
    digest: evidence["digest"],
  })}\n`,
);
process.exitCode = results.every((result) => result.pass) ? 0 : 1;
