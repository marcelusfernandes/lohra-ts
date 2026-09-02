import { connect, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startGatewayHttpServer, type GatewayHttpServer } from "../../src/gateway/http/server.js";
import { jsonResponse } from "../../src/gateway/http/response.js";

let activeServer: GatewayHttpServer | null = null;

afterEach(async () => {
  if (activeServer !== null) {
    await activeServer.close();
    activeServer = null;
  }
});

function rawRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket: Socket = connect(port, "127.0.0.1", () => {
      socket.write(requestText);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      resolvePromise(Buffer.concat(chunks).toString("binary"));
    });
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), 2000);
  });
}

describe("startGatewayHttpServer", () => {
  it("binds an ephemeral port when given port 0, and responds to a raw GET over a real socket", async () => {
    activeServer = await startGatewayHttpServer({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request) =>
        Promise.resolve(
          jsonResponse(200, { path: request.head.path, method: request.head.method }),
        ),
      onUpgrade: () => {
        throw new Error("no upgrade expected in this test");
      },
    });
    expect(activeServer.port).toBeGreaterThan(0);

    const raw = await rawRequest(
      activeServer.port,
      "GET /api/status HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
    );
    expect(raw).toContain("HTTP/1.1 200 OK\r\n");
    expect(raw).toContain('{"path":"/api/status","method":"GET"}');
  });

  it("waits for the full Content-Length body before dispatching", async () => {
    let seenBody = "";
    activeServer = await startGatewayHttpServer({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request) => {
        seenBody = request.body.toString("utf8");
        return Promise.resolve(jsonResponse(200, { ok: true }));
      },
      onUpgrade: () => {
        throw new Error("no upgrade expected");
      },
    });
    await rawRequest(
      activeServer.port,
      "PUT /api/config HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
    );
    expect(seenBody).toBe("hello");
  });

  it("handles two pipelined requests on the same connection", async () => {
    const seenPaths: string[] = [];
    activeServer = await startGatewayHttpServer({
      host: "127.0.0.1",
      port: 0,
      onRequest: (request) => {
        seenPaths.push(request.head.path);
        return Promise.resolve(jsonResponse(200, { ok: true }));
      },
      onUpgrade: () => {
        throw new Error("no upgrade expected");
      },
    });
    await rawRequest(
      activeServer.port,
      "GET /a HTTP/1.1\r\nHost: h\r\n\r\nGET /b HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
    );
    expect(seenPaths).toEqual(["/a", "/b"]);
  });

  it("routes an Upgrade: websocket request to onUpgrade instead of onRequest", async () => {
    let upgraded = false;
    activeServer = await startGatewayHttpServer({
      host: "127.0.0.1",
      port: 0,
      onRequest: () => Promise.reject(new Error("onRequest should not be called for an upgrade")),
      onUpgrade: (head, socket) => {
        upgraded = true;
        expect(head.path).toBe("/api/ws?token=x");
        socket.end();
      },
    });
    await rawRequest(
      activeServer.port,
      "GET /api/ws?token=x HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    expect(upgraded).toBe(true);
  });
});
