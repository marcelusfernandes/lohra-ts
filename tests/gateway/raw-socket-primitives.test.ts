import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, SessionRepository } from "../../src/state/index.js";
import { GatewaySessionRegistry } from "../../src/gateway/session-service.js";
import { createGatewayUpgradeHandler } from "../../src/gateway/ws/connection.js";
import { startGatewayHttpServer, type GatewayHttpServer } from "../../src/gateway/http/server.js";
import { routeGatewayRequest, type RouteContext } from "../../src/gateway/http/routes.js";
import { sendRawHttpRequest } from "../../scripts/parity/gateway/raw-http-client.js";
import { connectRawWs, decodeCloseFrame, WS_OPCODE } from "../../scripts/parity/gateway/raw-ws-client.js";

// Self-validation of the harness's own raw-socket primitives (the ones the
// Evaluator-facing scenario harness will use as principal evidence)
// against this session's own gateway server implementation, which has
// already been validated against the contract through the ws library and
// higher-level tests. If these primitives decode the SAME server
// correctly using nothing but hand-rolled HTTP/RFC6455 parsing, they're
// trustworthy for the harness scripts built on top of them.

const roots: string[] = [];
let activeServer: GatewayHttpServer | null = null;

afterEach(async () => {
  if (activeServer !== null) {
    await activeServer.close();
    activeServer = null;
  }
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const TOKEN = "the-raw-socket-token";

async function startServer(authRequired = true): Promise<GatewayHttpServer> {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-raw-socket-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  const registry = new GatewaySessionRegistry(sessions);
  const routeContext: RouteContext = {
    expectedToken: TOKEN,
    authRequired,
    handlers: {
      status: () => ({ ok: true, version: "0.0.11", sessions: registry.list().length }),
      sessions: () => ({ sessions: registry.list() }),
      messages: (sessionId) => ({ messages: registry.history(sessionId) }),
      config: () => ({ version: "0.0.11", auth_required: authRequired }),
    },
  };
  const onUpgrade = createGatewayUpgradeHandler({
    registry,
    auth: { authRequired, expectedToken: TOKEN },
    sessionDefaults: { model: "gpt-5", systemPrompt: "sp", cwd: "/tmp" },
    toolNames: ["read_file"],
    toolDefinitions: [],
    home: root,
    provider: "test-provider",
    createModelTransport: () => {
      throw new Error("no prompt.submit exercised in this file");
    },
    createConversationRepository: () => {
      throw new Error("no prompt.submit exercised in this file");
    },
    dispatchTool: () => Promise.reject(new Error("no tool dispatch exercised in this file")),
  });
  const server = await startGatewayHttpServer({
    host: "127.0.0.1",
    port: 0,
    onRequest: (request) => Promise.resolve(routeGatewayRequest(request.head, routeContext)),
    onUpgrade,
  });
  activeServer = server;
  return server;
}

describe("raw HTTP client: byte-exact request/response over a real socket", () => {
  it("GET /api/status with the correct token -> 200, exact JSON body", async () => {
    const server = await startServer();
    const response = await sendRawHttpRequest("127.0.0.1", server.port, {
      method: "GET",
      path: "/api/status",
      headers: [
        ["Host", "127.0.0.1"],
        ["X-Lohra-Session-Token", TOKEN],
        ["Connection", "close"],
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.toString("utf8")).toBe('{"ok":true,"version":"0.0.11","sessions":0}');
  });

  it("GET /api/status without a token -> 401 {\"detail\":\"Unauthorized\"}", async () => {
    const server = await startServer();
    const response = await sendRawHttpRequest("127.0.0.1", server.port, {
      method: "GET",
      path: "/api/status",
      headers: [
        ["Host", "127.0.0.1"],
        ["Connection", "close"],
      ],
    });
    expect(response.status).toBe(401);
    expect(response.body.toString("utf8")).toBe('{"detail":"Unauthorized"}');
  });

  it("captures the Location header verbatim, reflecting an arbitrary Host with no validation (L23)", async () => {
    const server = await startServer();
    const response = await sendRawHttpRequest("127.0.0.1", server.port, {
      method: "GET",
      path: "/api/status/",
      headers: [
        ["Host", "evil.example:8080"],
        ["X-Lohra-Session-Token", TOKEN],
        ["Connection", "close"],
      ],
    });
    expect(response.status).toBe(307);
    const location = response.headers.find(([name]) => name.toLowerCase() === "location")?.[1];
    expect(location).toBe("http://evil.example:8080/api/status");
  });
});

describe("raw RFC6455 client: handshake and frame decoding over a real socket", () => {
  it("handshake status is 101, Sec-WebSocket-Accept is valid, gateway.ready is a 122-byte text frame", async () => {
    const server = await startServer();
    const client = await connectRawWs("127.0.0.1", server.port, `/api/ws?token=${TOKEN}`);
    expect(client.handshake.status).toBe(101);

    const frame = await client.nextFrame();
    expect(frame.opcode).toBe(WS_OPCODE.text);
    expect(frame.fin).toBe(true);
    expect(frame.payload.length).toBe(122);
    expect(frame.payload.toString("utf8")).toBe(
      '{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","session_id":null,"payload":{"skin":{"name":"lohra"}}}}',
    );
    client.close();
  });

  it("auth failure: handshake still 101, then a close frame with code 4401 and empty reason (assertion 19)", async () => {
    const server = await startServer();
    const client = await connectRawWs("127.0.0.1", server.port, "/api/ws");
    expect(client.handshake.status).toBe(101);

    const frame = await client.nextFrame();
    expect(frame.opcode).toBe(WS_OPCODE.close);
    const { code, reason } = decodeCloseFrame(frame.payload);
    expect(code).toBe(4401);
    expect(reason).toBe("");
    client.close();
  });

  it("a binary frame kills the socket with no close frame at all (L6/assertion 24)", async () => {
    const server = await startServer();
    const client = await connectRawWs("127.0.0.1", server.port, `/api/ws?token=${TOKEN}`);
    await client.nextFrame(); // gateway.ready

    client.sendBinary(Buffer.from([1, 2, 3]));
    // No orderly close frame arrives -- the raw TCP connection just dies.
    // A well-formed close frame would resolve nextFrame(); the absence
    // proves the abrupt-termination behavior at the wire level, not just
    // "the ws library's close event fired eventually".
    await expect(client.nextFrame(500)).rejects.toThrow(/RAW_WS_NEXT_FRAME_TIMEOUT/u);
    client.close();
  });
});
