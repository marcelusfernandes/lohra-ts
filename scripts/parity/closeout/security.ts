import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MCPManager, type MCPSession } from "../../../src/mcp/index.js";
import { MCPToolNameCollisionError } from "../../../src/mcp/tools.js";
import { openStateDatabase, SessionRepository } from "../../../src/state/index.js";
import { createBuiltinRegistry } from "../../../src/tools/index.js";
import { GatewaySessionRegistry } from "../../../src/gateway/session-service.js";
import { evidenceTargetSha } from "./evidence.js";

const project = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(project, ".parity-evidence", "t22");
const root = mkdtempSync(join(tmpdir(), "lohra-t22-security-"));

function tool(name: string): unknown {
  return { name, description: "fixture", inputSchema: { type: "object" } };
}

function snapshot(registry: ReturnType<typeof createBuiltinRegistry>): string {
  return JSON.stringify(registry.getDefinitions());
}

function ownValue(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

try {
  const registry = createBuiltinRegistry();
  const before = snapshot(registry);
  const closed: string[] = [];
  const sessions = new Map<string, MCPSession>();
  for (const name of ["first!", "first@"] as const) {
    sessions.set(name, {
      listTools: () => Promise.resolve([tool("ping")]),
      callTool: () => Promise.resolve({ content: [{ type: "text", text: name }] }),
      close: () => {
        closed.push(name);
        return Promise.resolve();
      },
    });
  }
  const manager = new MCPManager(registry, (config) =>
    Promise.resolve(sessions.get(config.name) as MCPSession),
  );
  let collision: unknown;
  try {
    await manager.connectAll([
      { name: "first!", transport: "stdio", command: "fixture", args: [], env: {} },
      { name: "first@", transport: "stdio", command: "fixture", args: [], env: {} },
    ]);
  } catch (error) {
    collision = error;
  }
  if (!(collision instanceof MCPToolNameCollisionError)) throw new Error("MCP_COLLISION_CAUSE");
  if (ownValue(collision, "cause") !== "MCP_TOOL_NAME_COLLISION") {
    throw new Error("MCP_COLLISION_CODE");
  }
  if (collision.message !== "MCP tool name collision: mcp_first_ping") {
    throw new Error("MCP_COLLISION_MESSAGE");
  }
  if (snapshot(registry) !== before) throw new Error("MCP_COLLISION_PARTIAL_PUBLICATION");
  if (closed.length !== 2 || new Set(closed).size !== 2) throw new Error("MCP_COLLISION_LEAK");

  let refreshed = false;
  const stableSession: MCPSession = {
    listTools: () => Promise.resolve(refreshed ? [tool("same!"), tool("same@")] : [tool("stable")]),
    callTool: () => Promise.resolve({ content: [{ type: "text", text: "stable" }] }),
    close: () => Promise.resolve(),
  };
  const stableRegistry = createBuiltinRegistry();
  const stableManager = new MCPManager(stableRegistry, () => Promise.resolve(stableSession));
  await stableManager.connectAll([
    { name: "stable", transport: "stdio", command: "fixture", args: [], env: {} },
  ]);
  const stableBefore = snapshot(stableRegistry);
  refreshed = true;
  let refreshCollision: unknown;
  try {
    await stableManager.refresh("stable");
  } catch (error) {
    refreshCollision = error;
  }
  if (!(refreshCollision instanceof MCPToolNameCollisionError)) {
    throw new Error("MCP_REFRESH_COLLISION_CAUSE");
  }
  if (snapshot(stableRegistry) !== stableBefore) throw new Error("MCP_REFRESH_CLEARED_OLD");
  const stillServing = await stableRegistry.dispatch("mcp_stable_stable", {});
  if (!stillServing.includes("stable")) throw new Error("MCP_REFRESH_OLD_NOT_SERVING");
  await stableManager.shutdown();

  const connection = openStateDatabase(join(root, "state.db"));
  const sessionRepository = new SessionRepository(
    connection.database,
    undefined,
    connection.ftsEnabled,
  );
  const gateway = new GatewaySessionRegistry(sessionRepository);
  sessionRepository.createSession({
    id: "subsession",
    source: "fixture",
    model: "fixture",
    systemPrompt: "child",
    cwd: root,
    startedAt: 1,
    parentSessionId: "parent",
  });
  if (gateway.promptSubmissionRejection("subsession") !== "subsession") {
    throw new Error("SUBSESSION_PRIVILEGE_PROMOTION_DENIED");
  }
  connection.close();

  const observation = {
    targetSha: evidenceTargetSha(project),
    mcp: {
      cause: "MCP_TOOL_NAME_COLLISION",
      message: "MCP tool name collision: mcp_first_ping",
      batchAtomic: true,
      transientsClosed: true,
      refreshPreservedOld: true,
    },
    l22: {
      cause: "SUBSESSION_PRIVILEGE_PROMOTION_DENIED",
      message: "subsession cannot be promoted to a gateway session",
      rejectedBeforePromotion: true,
    },
    networkUsed: false,
    credentialsUsed: false,
  };
  const canonical = `${JSON.stringify(observation)}\n`;
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, "security.json"), canonical);
  process.stdout.write(
    `${JSON.stringify({ ...observation, digest: createHash("sha256").update(canonical).digest("hex") })}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
