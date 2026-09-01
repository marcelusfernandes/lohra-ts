#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import {
  deregisterServer,
  MCPManager,
  registerServerTools,
  type MCPSession,
  type MCPServerConfig,
} from "../../../src/mcp/index.js";
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

const results: ScenarioResult[] = [];

results.push(
  await scenario("t19-shadow-deregister-orphan", [15, 16, 22], "process-ts supporting", () => {
    const registry = new ToolRegistry();
    const tool = [{ name: "search", description: "d", inputSchema: { type: "object" } }];
    registerServerTools(registry, "github.com", tool, () => ({ content: [], isError: false }));
    registerServerTools(registry, "github_com", tool, () => ({ content: [], isError: false }));
    const before = {
      loser: registry.namesInToolset("mcp-github.com"),
      winner: registry.namesInToolset("mcp-github_com"),
    };
    deregisterServer(registry, "github.com");
    const afterLoserDeregister = registry.namesInToolset("mcp-github_com");
    deregisterServer(registry, "github_com");
    const afterWinnerDeregister = registry.namesInToolset("mcp-github_com");

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
        before.loser.length === 0 &&
        JSON.stringify(before.winner) === JSON.stringify(["mcp_github_com_search"]) &&
        JSON.stringify(afterLoserDeregister) === JSON.stringify(["mcp_github_com_search"]) &&
        afterWinnerDeregister.length === 0 &&
        JSON.stringify(rawToolsetProof.raw) === JSON.stringify(["mcp_my_server_weird_name"]) &&
        rawToolsetProof.sanitized.length === 0,
      projection: {
        before,
        afterLoserDeregister,
        afterWinnerDeregister,
        rawToolsetProof,
        publicOwnerProof: "t19-cross-server-shadow-last-wins",
        publicNamingProof: "t19-naming-sanitization",
        debtClosed: false,
      },
      note: "Lifecycle and raw-toolset consequences are supporting process evidence; public ownership/name sanitization are exercised in the linked chat-bilateral scenarios.",
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
    const searched = spawnSync("rg", ["-n", "\\.refresh\\(", "src", "--glob", "*.ts"], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    if (searched.error !== undefined) {
      throw new Error(`T19_STATIC_SCAN_FAILED:${searched.error.message}`);
    }
    if (searched.status !== 0 && searched.status !== 1) {
      throw new Error(
        `T19_STATIC_SCAN_FAILED:exit=${String(searched.status)}:stderr=${searched.stderr}`,
      );
    }
    const matches = searched.stdout.split("\n").filter(Boolean);
    return {
      pass: searched.status === 1 && matches.length === 0,
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
