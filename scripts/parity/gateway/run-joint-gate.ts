// The joint T11+T12 gate: the REAL candidate `serve` (T11) and `dashboard`
// (T12) processes running SIMULTANEOUSLY on distinct ephemeral ports,
// sharing one loopback fake upstream, proving the two surfaces coexist
// without leaking into each other. Unlike run-scenarios.ts (oracle vs
// candidate, [socket-bilateral]), this is candidate-vs-candidate --
// [processo-ts] evidence, real separate OS processes for both sides, no
// oracle involved. Every literal expected value below (401/404/405 body
// shapes, openapi paths, event vocabulary) was independently confirmed
// against this candidate's OWN source (src/server/*.ts, src/gateway/**)
// before being hard-coded here, per this project's defense-in-depth rule:
// a literal check backs a specific binding decision, it never substitutes
// for the structural property actually under test.
//
// Items 1-4 are the original T11 gate (baseline eval-t12-baseline.md §5),
// corrected so item 4 REQUIRES the 401 envelopes to DIFFER between
// surfaces -- a candidate that unified them would silently break both.
// Items 5-8 were added by the Evaluator: middleware non-leakage, a WS
// turn and an SSE stream running in parallel, the 4009/400-pre-SSE race
// in the same window, and process cleanup.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startServer, stopAndCleanup, sendRaw, type ServerHandle, type RawResponse } from "../openai-server/harness.js";
import { startFakeUpstream, UPSTREAM_FAILURE_NONCE, type FakeUpstream } from "./fake-upstream.js";
import { launchCandidateFakeUpstreamDashboard, type LaunchedGatewayProcess } from "./launch-candidate-fake.js";
import { sendRawHttpRequest, type RawHttpResponse } from "./raw-http-client.js";
import { connectRawWs, type RawWsClient } from "./raw-ws-client.js";

const projectRoot = resolve(import.meta.dirname, "../../..");
const evidenceRoot = resolve(projectRoot, ".parity-evidence/t12-joint-gate");
mkdirSync(evidenceRoot, { recursive: true });

const DASHBOARD_TOKEN = "t12-joint-gate-dashboard-token-BBBB";

interface GateResult {
  readonly id: string;
  readonly verdict: "match" | "divergent" | "error";
  readonly detail?: string;
  readonly evidence?: unknown;
}

function match(id: string, evidence: unknown): GateResult {
  return { id, verdict: "match", evidence };
}

function divergent(id: string, detail: string, evidence?: unknown): GateResult {
  return { id, verdict: "divergent", detail, evidence };
}

function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

// The fake upstream streams reply text word-by-word across separate SSE
// `data:` chunks (each its own JSON object) -- the assembled reply never
// appears as one contiguous substring in the raw wire bytes, so a raw
// .includes() search against the full body is structurally wrong. This
// reconstructs the text the same way a real SSE client would: parse each
// non-[DONE] data line, concatenate choices[0].delta.content.
function sseContent(body: string): string {
  let text = "";
  for (const frame of body.split("\n\n")) {
    const line = frame.trim();
    if (!line.startsWith("data:") || line === "data: [DONE]") continue;
    try {
      const parsed = JSON.parse(line.slice("data:".length).trim()) as {
        choices?: readonly { delta?: { content?: string } }[];
      };
      text += parsed.choices?.[0]?.delta?.content ?? "";
    } catch {
      continue;
    }
  }
  return text;
}

interface Fixture {
  readonly server: ServerHandle;
  readonly dashboard: LaunchedGatewayProcess;
  readonly fakeUpstream: FakeUpstream;
}

// -- server (T11) raw request helper ----------------------------------
function serverRequestLines(method: string, path: string, body: string, auth: "valid" | "invalid" | "none", apiKey: string): string {
  const authHeader =
    auth === "valid" ? `Authorization: Bearer ${apiKey}\n` : auth === "invalid" ? "Authorization: Bearer wrong-key-entirely\n" : "";
  return (
    `${method} ${path} HTTP/1.1\n` +
    "Host: 127.0.0.1\n" +
    "Content-Type: application/json\n" +
    `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\n` +
    authHeader +
    "Connection: close\n"
  );
}

// -- gateway (T12) raw request helper ----------------------------------
async function gatewayRequest(
  dashboard: LaunchedGatewayProcess,
  method: string,
  path: string,
  auth: "valid" | "invalid" | "none",
  body = "",
): Promise<RawHttpResponse> {
  const headers: (readonly [string, string])[] = [
    ["Host", "127.0.0.1"],
    ["Connection", "close"],
  ];
  if (auth === "valid") headers.push(["X-Lohra-Session-Token", DASHBOARD_TOKEN]);
  if (auth === "invalid") headers.push(["X-Lohra-Session-Token", "wrong-token-entirely"]);
  if (body.length > 0) {
    headers.push(["Content-Type", "application/json"]);
    headers.push(["Content-Length", String(Buffer.byteLength(body, "utf8"))]);
  }
  return sendRawHttpRequest("127.0.0.1", dashboard.port, { method, path, headers, body });
}

// item 1: an invalid /v1/chat/completions request (empty messages, even
// with stream:true) is refused BEFORE any SSE byte is written -- proven by
// checking the response is a plain JSON 400, never text/event-stream and
// never chunked. The gateway has no /v1/* routes at all, so it must 404.
async function g1StreamInvalidBeforeSse(fx: Fixture): Promise<GateResult> {
  const id = "t12-joint-gate-01-stream-invalid-before-sse";
  const body = JSON.stringify({ model: "fake-model-a", stream: true, messages: [] });
  const serverResponse = await sendRaw(fx.server.port, serverRequestLines("POST", "/v1/chat/completions", body, "valid", fx.server.apiKey ?? ""), body);
  const serverContentType = serverResponse.headers.find(([name]) => name === "content-type")?.[1] ?? "";
  const serverJson = jsonOf(serverResponse.body) as { error?: { type?: string; message?: string } };
  const serverOk =
    serverResponse.statusLine.includes(" 400 ") &&
    serverContentType.includes("application/json") &&
    !serverContentType.includes("event-stream") &&
    !serverResponse.body.includes("data:") &&
    serverJson.error?.type === "invalid_request_error" &&
    (serverJson.error.message ?? "").toLowerCase().includes("empty");
  if (!serverOk) {
    return divergent(id, "server did not refuse pre-SSE as expected", { serverResponse });
  }

  const gatewayResponse = await gatewayRequest(fx.dashboard, "POST", "/v1/chat/completions", "none", body);
  const gatewayJson = jsonOf(gatewayResponse.body.toString("utf8"));
  const gatewayOk = gatewayResponse.status === 404 && JSON.stringify(gatewayJson) === JSON.stringify({ detail: "Not Found" });
  if (!gatewayOk) {
    return divergent(id, `gateway status=${String(gatewayResponse.status)} body=${gatewayResponse.body.toString("utf8")}`, { gatewayResponse });
  }
  return match(id, { server: { status: 400, error: serverJson.error }, gateway: { status: 404, body: gatewayJson } });
}

// item 2: a real upstream failure (418 + a canary substring) surfaces on
// BOTH surfaces via the SAME shared publicCauseMessage() helper -- same
// causal text, different envelope shape per surface (502+error.message on
// the server, message.complete.warning on the gateway).
async function g2UpstreamFailure(fx: Fixture): Promise<GateResult> {
  const id = "t12-joint-gate-02-upstream-failure";
  const serverBody = JSON.stringify({
    model: "fake-model-a",
    messages: [{ role: "user", content: `please ${UPSTREAM_FAILURE_NONCE}` }],
  });
  const serverResponse = await sendRaw(
    fx.server.port,
    serverRequestLines("POST", "/v1/chat/completions", serverBody, "valid", fx.server.apiKey ?? ""),
    serverBody,
  );
  const serverJson = jsonOf(serverResponse.body) as { error?: { type?: string; message?: string } };
  const serverOk =
    serverResponse.statusLine.includes(" 502 ") &&
    serverJson.error?.type === "upstream_error" &&
    (serverJson.error.message ?? "").includes("418") &&
    (serverJson.error.message ?? "").includes(UPSTREAM_FAILURE_NONCE);
  if (!serverOk) return divergent(id, "server did not surface the upstream failure as expected", { serverResponse });

  const ws = await connectRawWs("127.0.0.1", fx.dashboard.port, `/api/ws?token=${DASHBOARD_TOKEN}`);
  try {
    await ws.nextFrame(); // gateway.ready
    ws.sendText(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: {} }));
    const createFrame = await ws.nextFrame();
    const createEnvelope = JSON.parse(createFrame.payload.toString("utf8")) as { result?: { session_id?: string } };
    const sessionId = createEnvelope.result?.session_id ?? "";
    ws.sendText(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "prompt.submit",
        params: { session_id: sessionId, text: `please ${UPSTREAM_FAILURE_NONCE}` },
      }),
    );
    let completePayload: { status?: string; warning?: string } | null = null;
    for (let i = 0; i < 12 && completePayload === null; i += 1) {
      const frame = await ws.nextFrame(10_000);
      const envelope = JSON.parse(frame.payload.toString("utf8")) as {
        method?: string;
        params?: { type?: string; payload?: { status?: string; warning?: string } };
      };
      if (envelope.method === "event" && envelope.params?.type === "message.complete") {
        completePayload = envelope.params.payload ?? null;
      }
    }
    const gatewayOk =
      completePayload?.status === "error" &&
      (completePayload.warning ?? "").includes("418") &&
      (completePayload.warning ?? "").includes(UPSTREAM_FAILURE_NONCE);
    if (!gatewayOk) return divergent(id, "gateway did not surface the upstream failure as expected", { completePayload });

    return match(id, { server: { status: 502, error: serverJson.error }, gateway: { messageComplete: completePayload } });
  } finally {
    ws.close();
  }
}

// item 3: /v1/runs is a documented-but-absent route on the server and does
// not exist at all on the gateway -- 404 on both, on GET and POST, with
// and without auth (4/4 each), since routing happens before any auth
// check reaches an undefined path on either surface.
async function g3RunsFourOfFour(fx: Fixture): Promise<GateResult> {
  const id = "t12-joint-gate-03-v1-runs-four-of-four";
  const combos: readonly ["GET" | "POST", "valid" | "none"][] = [
    ["GET", "none"],
    ["GET", "valid"],
    ["POST", "none"],
    ["POST", "valid"],
  ];
  const serverResults = await Promise.all(
    combos.map(async ([method, auth]) => {
      const body = method === "POST" ? "{}" : "";
      const response = await sendRaw(fx.server.port, serverRequestLines(method, "/v1/runs", body, auth === "valid" ? "valid" : "none", fx.server.apiKey ?? ""), body);
      return { method, auth, status: response.statusLine, body: jsonOf(response.body) };
    }),
  );
  const gatewayResults = await Promise.all(
    combos.map(async ([method, auth]) => {
      const body = method === "POST" ? "{}" : "";
      const response = await gatewayRequest(fx.dashboard, method, "/v1/runs", auth, body);
      return { method, auth, status: response.status, body: jsonOf(response.body.toString("utf8")) };
    }),
  );
  const expected = JSON.stringify({ detail: "Not Found" });
  const serverOk = serverResults.every((r) => r.status.includes(" 404 ") && JSON.stringify(r.body) === expected);
  const gatewayOk = gatewayResults.every((r) => r.status === 404 && JSON.stringify(r.body) === expected);
  if (!serverOk || !gatewayOk) return divergent(id, "not all 4/4 combos were 404 on both surfaces", { serverResults, gatewayResults });
  return match(id, { serverResults, gatewayResults });
}

// item 4 (corrected semantics): the 401 envelopes must DIFFER between
// surfaces -- a TS that unified them would silently break both. Also
// cross-probes each surface's own credential against the OTHER surface
// (still 401, proves the schemes are mutually inert), compares the
// openapi.json path sets (disjoint, each matching its own known routes),
// and confirms each surface's own 405 shape.
async function g4VocabulariesDiffer(fx: Fixture): Promise<GateResult> {
  const id = "t12-joint-gate-04-vocabularies-differ";

  const serverUnauthed = await sendRaw(fx.server.port, serverRequestLines("GET", "/v1/models", "", "none", ""), "");
  const serverUnauthedJson = jsonOf(serverUnauthed.body);
  const gatewayUnauthed = await gatewayRequest(fx.dashboard, "GET", "/api/status", "none");
  const gatewayUnauthedJson = jsonOf(gatewayUnauthed.body.toString("utf8"));

  const envelopesDiffer = JSON.stringify(serverUnauthedJson) !== JSON.stringify(gatewayUnauthedJson);
  const serverShapeOk =
    serverUnauthed.statusLine.includes(" 401 ") &&
    JSON.stringify(serverUnauthedJson) === JSON.stringify({ error: { message: "missing or invalid API key", type: "authentication_error" } });
  const gatewayShapeOk = gatewayUnauthed.status === 401 && JSON.stringify(gatewayUnauthedJson) === JSON.stringify({ detail: "Unauthorized" });
  if (!envelopesDiffer || !serverShapeOk || !gatewayShapeOk) {
    return divergent(id, "401 envelopes did not both match their own known shape and differ from each other", {
      serverUnauthedJson,
      gatewayUnauthedJson,
    });
  }

  // cross-probe: each surface's OWN valid credential, presented to the
  // OTHER surface, must still be rejected -- the two auth schemes are
  // mutually inert, not silently interchangeable.
  const serverCredOnGateway = await gatewayRequest(fx.dashboard, "GET", "/api/status", "none", "");
  // (re-issued manually below with the server's Bearer value in the token header)
  const crossHeaders: (readonly [string, string])[] = [
    ["Host", "127.0.0.1"],
    ["Connection", "close"],
    ["X-Lohra-Session-Token", fx.server.apiKey ?? ""],
  ];
  const serverCredOnGatewayResponse = await sendRawHttpRequest("127.0.0.1", fx.dashboard.port, {
    method: "GET",
    path: "/api/status",
    headers: crossHeaders,
  });
  const dashboardCredOnServerBody = "";
  const dashboardCredOnServer = await sendRaw(
    fx.server.port,
    `GET /v1/models HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer ${DASHBOARD_TOKEN}\nConnection: close\n`,
    dashboardCredOnServerBody,
  );
  const crossOk = serverCredOnGatewayResponse.status === 401 && dashboardCredOnServer.statusLine.includes(" 401 ");
  if (!crossOk) {
    return divergent(id, "cross-surface credentials were not both rejected", { serverCredOnGatewayResponse, dashboardCredOnServer });
  }
  void serverCredOnGateway;

  const serverOpenapi = await sendRaw(fx.server.port, "GET /openapi.json HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n", "");
  const gatewayOpenapi = await gatewayRequest(fx.dashboard, "GET", "/openapi.json", "none");
  const serverPaths = Object.keys(((jsonOf(serverOpenapi.body) as { paths?: Record<string, unknown> }).paths) ?? {}).sort();
  const gatewayPaths = Object.keys(
    ((jsonOf(gatewayOpenapi.body.toString("utf8")) as { paths?: Record<string, unknown> }).paths) ?? {},
  ).sort();
  const expectedServerPaths = ["/health", "/v1/chat/completions", "/v1/models", "/v1/responses"];
  const expectedGatewayPaths = ["/api/config", "/api/sessions", "/api/sessions/{session_id}/messages", "/api/status"];
  const openapiOk =
    JSON.stringify(serverPaths) === JSON.stringify(expectedServerPaths) &&
    JSON.stringify(gatewayPaths) === JSON.stringify(expectedGatewayPaths);
  if (!openapiOk) return divergent(id, "openapi path sets did not match their expected, disjoint shapes", { serverPaths, gatewayPaths });

  const serverMethodNotAllowed = await sendRaw(fx.server.port, "PUT /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n", "");
  // POST, not HEAD: HEAD always strips the response body regardless of
  // status (routes.ts's stripBodyForHead), so a HEAD-based 405 body is
  // structurally empty no matter what -- comparing it against the
  // server's populated 405 body would be an apples-to-oranges harness bug,
  // not a genuine shape divergence.
  const gatewayMethodNotAllowed = await gatewayRequest(fx.dashboard, "POST", "/api/status", "valid", "{}");
  const bothShape = JSON.stringify({ detail: "Method Not Allowed" });
  const methodNotAllowedOk =
    serverMethodNotAllowed.statusLine.includes(" 405 ") &&
    JSON.stringify(jsonOf(serverMethodNotAllowed.body)) === bothShape &&
    gatewayMethodNotAllowed.status === 405 &&
    JSON.stringify(jsonOf(gatewayMethodNotAllowed.body.toString("utf8"))) === bothShape;
  if (!methodNotAllowedOk) {
    return divergent(id, "405 shape was not the identical FastAPI-style default on both surfaces", { serverMethodNotAllowed, gatewayMethodNotAllowed });
  }

  return match(id, {
    envelopesDiffer: { server: serverUnauthedJson, gateway: gatewayUnauthedJson },
    openapi: { serverPaths, gatewayPaths },
    methodNotAllowed: bothShape,
  });
}

// item 5 (Evaluator-added): middleware non-leakage -- a gateway-only path
// on the server, and a server-only path on the gateway, each observed to
// fall through to that SURFACE's own routing/auth behavior rather than
// silently succeeding or borrowing the other surface's response shape.
async function g5MiddlewareNonLeakage(fx: Fixture): Promise<GateResult> {
  const id = "t12-joint-gate-05-middleware-non-leakage";
  const gatewayResponse = await gatewayRequest(fx.dashboard, "POST", "/v1/chat/completions", "none", "{}");
  const gatewayJson = jsonOf(gatewayResponse.body.toString("utf8"));
  const gatewayOk = gatewayResponse.status === 404 && JSON.stringify(gatewayJson) === JSON.stringify({ detail: "Not Found" });

  const serverResponse = await sendRaw(fx.server.port, "GET /api/status HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n", "");
  const serverJson = jsonOf(serverResponse.body);
  // Measured fact, not assumed: the server's route table has no entry for
  // /api/status at all, and its dispatch() routes BEFORE any auth check
  // runs -- so the correct non-leakage proof is 404 (undefined path),
  // never a 200 that would mean the gateway's OWN route handler got
  // reached through the wrong process, and never silently reusing the
  // gateway's {"detail":"Unauthorized"} shape either.
  const serverOk = serverResponse.statusLine.includes(" 404 ") && JSON.stringify(serverJson) === JSON.stringify({ detail: "Not Found" });

  if (!gatewayOk || !serverOk) {
    return divergent(id, "a cross-surface-only path did not fall through to that surface's own routing", { gatewayResponse, serverResponse });
  }
  return match(id, { gateway: { status: 404, body: gatewayJson }, server: { status: 404, body: serverJson } });
}

// item 6 (Evaluator-added): a full gateway WS turn and a full server SSE
// stream, driven CONCURRENTLY against the shared fake upstream, each
// completing with its own correct framing and no interference.
async function g6ParallelTurnAndStream(fx: Fixture): Promise<GateResult> {
  const id = "t12-joint-gate-06-parallel-ws-turn-and-sse-stream";
  fx.fakeUpstream.setNextContent("joint gate parallel reply");

  const serverBody = JSON.stringify({ model: "fake-model-a", stream: true, messages: [{ role: "user", content: "hello server" }] });
  const serverStreamPromise = sendRaw(
    fx.server.port,
    serverRequestLines("POST", "/v1/chat/completions", serverBody, "valid", fx.server.apiKey ?? ""),
    serverBody,
  );

  const gatewayTurnPromise = (async (): Promise<{ readonly sequence: readonly string[]; readonly completePayload: unknown }> => {
    const ws: RawWsClient = await connectRawWs("127.0.0.1", fx.dashboard.port, `/api/ws?token=${DASHBOARD_TOKEN}`);
    try {
      await ws.nextFrame(); // gateway.ready
      ws.sendText(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: {} }));
      const createFrame = await ws.nextFrame();
      const createEnvelope = JSON.parse(createFrame.payload.toString("utf8")) as { result?: { session_id?: string } };
      const sessionId = createEnvelope.result?.session_id ?? "";
      ws.sendText(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: sessionId, text: "hello gateway" } }),
      );
      const sequence: string[] = [];
      let completePayload: unknown = null;
      for (let i = 0; i < 12 && completePayload === null; i += 1) {
        const frame = await ws.nextFrame(10_000);
        const envelope = JSON.parse(frame.payload.toString("utf8")) as { method?: string; params?: { type?: string; payload?: unknown } };
        if (envelope.method === "event" && envelope.params !== undefined) {
          sequence.push(envelope.params.type ?? "?");
          if (envelope.params.type === "message.complete") completePayload = envelope.params.payload;
        }
      }
      return { sequence, completePayload };
    } finally {
      ws.close();
    }
  })();

  const [serverStreamResult, gatewayTurnResult] = await Promise.all([serverStreamPromise, gatewayTurnPromise]);

  const serverOk =
    serverStreamResult.statusLine.includes(" 200 ") &&
    (serverStreamResult.headers.find(([n]) => n === "content-type")?.[1] ?? "").includes("text/event-stream") &&
    serverStreamResult.body.trimEnd().endsWith("data: [DONE]") &&
    sseContent(serverStreamResult.body).trim() === "joint gate parallel reply";
  const gatewayOk =
    gatewayTurnResult.sequence.includes("message.start") &&
    gatewayTurnResult.sequence[gatewayTurnResult.sequence.length - 1] === "message.complete" &&
    (gatewayTurnResult.completePayload as { status?: string } | null)?.status !== "error";

  if (!serverOk || !gatewayOk) {
    return divergent(id, "parallel turn/stream did not both complete cleanly", { serverStreamResult, gatewayTurnResult });
  }
  return match(id, { server: { done: true }, gateway: gatewayTurnResult });
}

// item 7 (Evaluator-added): while the gateway holds a turn genuinely "in
// flight" (a deterministic synchronization point via the fake upstream's
// holdNextStream(), not a timing race -- matching this project's own
// established practice), a SECOND socket submitting to the SAME session
// gets 4009, and -- in that exact same window -- the server independently
// refuses an invalid pre-SSE request with its own 400 shape, proving
// neither surface's busy/validation state bleeds into the other's. Two
// separate connections, not two messages on one socket: this gateway
// deliberately serializes messages PER SOCKET (already proven elsewhere
// in this project), so a second prompt.submit on the SAME connection as
// the held turn would just queue behind it instead of racing it -- the
// baseline's own busy proof used 4 separate sockets for exactly this
// reason.
async function g7BusyRaceSameWindow(fx: Fixture): Promise<GateResult> {
  const id = "t12-joint-gate-07-4009-and-400-pre-sse-same-window";
  fx.fakeUpstream.setNextContent("joint gate busy-race reply");
  const hold = fx.fakeUpstream.holdNextStream();
  let held = true;
  const releaseOnce = (): void => {
    if (held) {
      held = false;
      hold.release();
    }
  };

  const ws: RawWsClient = await connectRawWs("127.0.0.1", fx.dashboard.port, `/api/ws?token=${DASHBOARD_TOKEN}`);
  let ws2: RawWsClient | null = null;
  try {
    await ws.nextFrame(); // gateway.ready
    ws.sendText(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: {} }));
    const createFrame = await ws.nextFrame();
    const createEnvelope = JSON.parse(createFrame.payload.toString("utf8")) as { result?: { session_id?: string } };
    const sessionId = createEnvelope.result?.session_id ?? "";

    ws.sendText(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: sessionId, text: "hold me open" } }));
    // Wait for message.start -- proof the turn has genuinely begun (busy
    // engaged) before racing the second submit, rather than trusting
    // timing alone.
    let sawMessageStart = false;
    for (let i = 0; i < 6 && !sawMessageStart; i += 1) {
      const frame = await ws.nextFrame(5000);
      const envelope = JSON.parse(frame.payload.toString("utf8")) as { method?: string; params?: { type?: string } };
      if (envelope.method === "event" && envelope.params?.type === "message.start") sawMessageStart = true;
    }
    if (!sawMessageStart) {
      releaseOnce();
      return divergent(id, "never observed message.start before racing the second submit");
    }

    let busyFrame: Record<string, unknown> = {};
    let serverInvalidResponse: RawResponse | null = null;
    try {
      ws2 = await connectRawWs("127.0.0.1", fx.dashboard.port, `/api/ws?token=${DASHBOARD_TOKEN}`);
      await ws2.nextFrame(); // gateway.ready on the second socket
      const invalidBody = JSON.stringify({ model: "fake-model-a", stream: true, messages: [] });
      [busyFrame, serverInvalidResponse] = await Promise.all([
        (async (): Promise<Record<string, unknown>> => {
          (ws2).sendText(
            JSON.stringify({ jsonrpc: "2.0", id: 3, method: "prompt.submit", params: { session_id: sessionId, text: "second submit" } }),
          );
          const frame = await (ws2).nextFrame(5000);
          return JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
        })(),
        sendRaw(fx.server.port, serverRequestLines("POST", "/v1/chat/completions", invalidBody, "valid", fx.server.apiKey ?? ""), invalidBody),
      ]);
    } finally {
      // ALWAYS release, even if the race itself threw -- otherwise the
      // held turn never completes and item 8's SIGINT cleanup has to
      // fall back to SIGKILL, cascading this scenario's own bug into a
      // false "cleanup didn't exit 0" failure on an unrelated item.
      releaseOnce();
    }

    const busyOk = JSON.stringify(busyFrame.error) === JSON.stringify({ code: 4009, message: "session busy" });
    const serverInvalidJson = jsonOf(serverInvalidResponse.body) as { error?: { type?: string } };
    const serverInvalidOk =
      serverInvalidResponse.statusLine.includes(" 400 ") &&
      serverInvalidJson.error?.type === "invalid_request_error" &&
      !serverInvalidResponse.body.includes("data:");

    // Drain the original held turn to completion so nothing is left
    // dangling for the cleanup gate (item 8) to trip over.
    let completed = false;
    for (let i = 0; i < 12 && !completed; i += 1) {
      const frame = await ws.nextFrame(10_000);
      const envelope = JSON.parse(frame.payload.toString("utf8")) as { method?: string; params?: { type?: string } };
      if (envelope.method === "event" && envelope.params?.type === "message.complete") completed = true;
    }

    if (!busyOk || !serverInvalidOk || !completed) {
      return divergent(id, "busy/pre-SSE race or cleanup drain did not match expectations", { busyFrame, serverInvalidResponse, completed });
    }
    return match(id, { gatewayBusy: busyFrame.error, serverInvalid: serverInvalidJson.error, heldTurnCompleted: completed });
  } finally {
    releaseOnce();
    ws2?.close();
    ws.close();
  }
}

// item 8 (Evaluator-added): SIGINT both processes and prove clean exit --
// exit code 0 for both, and both ports genuinely released (a fresh bind
// on the exact same port succeeds), not just "the harness stopped
// watching". Must run LAST: it terminates both shared servers.
async function g8Cleanup(fx: Fixture): Promise<GateResult> {
  const id = "t12-joint-gate-08-cleanup";
  const serverPort = fx.server.port;
  const dashboardPort = fx.dashboard.port;

  const serverExit = await stopAndCleanup(fx.server);
  const dashboardExit = await fx.dashboard.kill("SIGINT");

  async function portReleased(port: number): Promise<boolean> {
    return await new Promise((resolvePromise) => {
      const probe = createServer();
      probe.once("error", () => { resolvePromise(false); });
      probe.listen(port, "127.0.0.1", () => {
        probe.close(() => { resolvePromise(true); });
      });
    });
  }

  const serverPortReleased = await portReleased(serverPort);
  const dashboardPortReleased = await portReleased(dashboardPort);

  const ok = serverExit.exitCode === 0 && dashboardExit.exitCode === 0 && serverPortReleased && dashboardPortReleased;
  if (!ok) {
    return divergent(id, "cleanup did not produce exit 0 + released ports on both surfaces", {
      serverExit,
      dashboardExit,
      serverPortReleased,
      dashboardPortReleased,
    });
  }
  return match(id, { serverExit, dashboardExit, serverPortReleased, dashboardPortReleased });
}

async function main(): Promise<void> {
  const fakeUpstream = await startFakeUpstream();
  const server = await startServer("candidate", {}, `http://127.0.0.1:${String(fakeUpstream.port)}/v1`);
  const dashboardHome = mkdtempSync(join(tmpdir(), "lohra-t12-joint-dashboard-home-"));
  const dashboard = await launchCandidateFakeUpstreamDashboard({
    fakeUpstreamPort: fakeUpstream.port,
    home: dashboardHome,
    dashboardToken: DASHBOARD_TOKEN,
  });
  const fx: Fixture = { server, dashboard, fakeUpstream };

  const gateItems: readonly { readonly id: string; readonly run: (fixture: Fixture) => Promise<GateResult> }[] = [
    { id: "g1", run: g1StreamInvalidBeforeSse },
    { id: "g2", run: g2UpstreamFailure },
    { id: "g3", run: g3RunsFourOfFour },
    { id: "g4", run: g4VocabulariesDiffer },
    { id: "g5", run: g5MiddlewareNonLeakage },
    { id: "g6", run: g6ParallelTurnAndStream },
    { id: "g7", run: g7BusyRaceSameWindow },
    { id: "g8", run: g8Cleanup },
  ];

  const results: GateResult[] = [];
  // Tracks whether g8Cleanup's OWN body was reached, not whether its
  // assertions passed: g8 calls the real stopAndCleanup()/kill() as its
  // first actions, before checking exit codes/port release, so a
  // "divergent" verdict still means the processes were already killed.
  // Neither launcher's kill() is safe to call twice on an already-exited
  // child -- a listener registered on 'exit' after the process has
  // already died never fires, so a duplicate call hangs forever. Gating
  // on verdict instead of "did g8 run" caused exactly that hang.
  let g8Attempted = false;
  try {
    for (const item of gateItems) {
      console.error(`-- starting ${item.id}...`);
      if (item.id === "g8") g8Attempted = true;
      try {
        const result = await item.run(fx);
        console.error(`-- ${item.id} -> ${result.verdict}`);
        results.push(result);
      } catch (error) {
        console.error(`-- ${item.id} -> threw: ${error instanceof Error ? error.message : String(error)}`);
        results.push({ id: item.id, verdict: "error", detail: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    if (!g8Attempted) {
      // Only reached if an earlier item threw badly enough to abort the
      // loop before g8 ever ran -- g8 itself already handles the
      // normal-path shutdown in every other case.
      await stopAndCleanup(server).catch(() => undefined);
      await dashboard.kill("SIGKILL").catch(() => undefined);
    }
    await fakeUpstream.close();
  }

  const projections = results.map((result) => {
    const sha = createHash("sha256").update(JSON.stringify({ verdict: result.verdict, detail: result.detail, evidence: result.evidence })).digest("hex");
    return { id: result.id, sha };
  });
  const digest = createHash("sha256").update(projections.map(({ id, sha }) => `${id}=${sha}\n`).join("")).digest("hex");

  const evidencePath = join(evidenceRoot, "run-joint-gate.json");
  writeFileSync(evidencePath, JSON.stringify({ suite: "t12-joint-gate-t11-serve-plus-t12-dashboard", digest, projections, results }, null, 2));

  const failed = results.filter((result) => result.verdict !== "match");
  for (const result of results) {
    const marker = result.verdict === "match" ? "PASS" : "FAIL";
    console.log(`[${marker}] ${result.id}${result.detail !== undefined ? ` -- ${result.detail}` : ""}`);
  }
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} gate items match.`);
  console.log(`Digest: ${digest}`);
  console.log(`Evidence: ${evidencePath}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
