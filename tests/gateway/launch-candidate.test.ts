import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  launchCandidateDashboard,
  type LaunchedGatewayProcess,
} from "../../scripts/parity/gateway/launch-candidate.js";
import { sendRawHttpRequest } from "../../scripts/parity/gateway/raw-http-client.js";
import { connectRawWs, WS_OPCODE } from "../../scripts/parity/gateway/raw-ws-client.js";

// This is the first genuinely [processo-ts] + [socket-bilateral]-shaped
// test in this session: a real, separately spawned `lohra dashboard`
// process (via tsx against source, not in-process), probed with nothing
// but hand-rolled HTTP/RFC6455 sockets. No TestClient, no ws library, no
// direct function calls into the server module.

const roots: string[] = [];
let activeProcess: LaunchedGatewayProcess | null = null;

afterEach(async () => {
  if (activeProcess !== null) {
    await activeProcess.kill();
    activeProcess = null;
  }
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
}, 15_000);

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-launch-candidate-"));
  roots.push(root);
  return root;
}

describe("launchCandidateDashboard: a real subprocess, probed over raw sockets", () => {
  it("boots, serves authenticated REST, and completes a real RFC6455 WS handshake", async () => {
    const home = tempHome();
    const process_ = await launchCandidateDashboard({
      argv: ["--provider", "anthropic", "--insecure"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        LOHRA_HOME: home,
        ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
      },
      cwd: home,
      bootTimeoutMs: 20_000,
    });
    activeProcess = process_;

    const restResponse = await sendRawHttpRequest("127.0.0.1", process_.port, {
      method: "GET",
      path: "/api/status",
      headers: [
        ["Host", "127.0.0.1"],
        ["Connection", "close"],
      ],
    });
    expect(restResponse.status).toBe(200);
    const body = JSON.parse(restResponse.body.toString("utf8")) as { ok: boolean; version: string };
    expect(body).toEqual({ ok: true, version: "0.0.11", sessions: 0 });

    const wsClient = await connectRawWs("127.0.0.1", process_.port, "/api/ws");
    expect(wsClient.handshake.status).toBe(101);
    const readyFrame = await wsClient.nextFrame();
    expect(readyFrame.opcode).toBe(WS_OPCODE.text);
    const readyEvent = JSON.parse(readyFrame.payload.toString("utf8")) as {
      params: { type: string };
    };
    expect(readyEvent.params.type).toBe("gateway.ready");
    wsClient.close();

    const result = await process_.kill("SIGINT");
    activeProcess = null;
    expect(result.exitCode).toBe(0);
  }, 30_000);
});
