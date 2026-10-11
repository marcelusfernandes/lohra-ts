import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import {
  openStateDatabase,
  SessionRepository,
  type StateConnection,
} from "../../src/state/index.js";
import { SqliteConversationRepository } from "../../src/conversation/index.js";
import type { ModelRequest, ModelTransport } from "../../src/conversation/types.js";
import type { NormalizedResponse } from "../../src/transports/index.js";
import { GatewaySessionRegistry } from "../../src/gateway/session-service.js";
import { createGatewayUpgradeHandler } from "../../src/gateway/ws/connection.js";
import { startGatewayHttpServer, type GatewayHttpServer } from "../../src/gateway/http/server.js";
import { jsonResponse } from "../../src/gateway/http/response.js";

const fixtures: Array<{ root: string; connection?: StateConnection }> = [];
let activeServer: GatewayHttpServer | null = null;

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  if (activeServer !== null) {
    const server = activeServer;
    activeServer = null;
    try {
      await server.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    try {
      fixture.connection?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      rmSync(fixture.root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "gateway prompt.submit fixture cleanup failed");
  }
});

export const TOKEN = "the-prompt-submit-token";
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

export function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    content: "final",
    finishReason: "stop",
    toolCalls: [],
    reasoning: null,
    usage,
    providerData: null,
    ...overrides,
  };
}

type ScriptStep = (request: ModelRequest) => NormalizedResponse | Promise<NormalizedResponse>;

class ScriptedTransport implements ModelTransport {
  private call = 0;
  public constructor(private readonly script: readonly ScriptStep[]) {}
  async complete(request: ModelRequest): Promise<NormalizedResponse> {
    const step = this.script[this.call];
    this.call += 1;
    if (step === undefined) throw new Error("SCRIPT_EXHAUSTED");
    return await step(request);
  }
  close() {
    return Promise.resolve();
  }
}

interface StartServerOptions {
  readonly transportScript?: readonly ScriptStep[];
  readonly toolDispatch?: (name: string, argumentsJson: string) => Promise<string>;
}

export async function startServer(options: StartServerOptions = {}): Promise<{
  readonly server: GatewayHttpServer;
  readonly home: string;
  readonly sessions: SessionRepository;
}> {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-prompt-submit-"));
  const fixture: { root: string; connection?: StateConnection } = { root };
  fixtures.push(fixture);
  const connection = openStateDatabase(join(root, "state.db"));
  fixture.connection = connection;
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  const registry = new GatewaySessionRegistry(sessions);
  const onUpgrade = createGatewayUpgradeHandler({
    registry,
    auth: { authRequired: true, expectedToken: TOKEN },
    sessionDefaults: { model: "gpt-5", systemPrompt: "sp", cwd: "/tmp" },
    toolNames: ["read_file"],
    toolDefinitions: [],
    home: root,
    provider: "test-provider",
    createModelTransport: () =>
      new ScriptedTransport(options.transportScript ?? [() => response()]),
    createConversationRepository: () => new SqliteConversationRepository(sessions),
    dispatchTool: options.toolDispatch ?? (() => Promise.resolve('{"ok":true}')),
  });
  const server = await startGatewayHttpServer({
    host: "127.0.0.1",
    port: 0,
    onRequest: () => Promise.resolve(jsonResponse(404, { detail: "Not Found" })),
    onUpgrade,
  });
  activeServer = server;
  return { server, home: root, sessions };
}
