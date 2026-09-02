// Assertion 65: two simultaneous streams (within ONE side — concurrency
// across oracle/candidate would interleave their shared upstream traffic
// nondeterministically, exactly what probeBoth's sequential ordering
// exists to avoid) complete with distinct ids, each keeping its own
// content contiguous and isolated — no shared queue/counter/content leaks
// between the two connections.
//
// Assertion 66 (disconnect half; SIGINT is covered separately by
// t11-sigint-cleanup-and-port-reuse.ts): after a client disconnects
// mid-SSE, (a) a subsequent request on the same server instance completes
// normally, (b) the upstream never receives an extra request because of
// the disconnect.
import net from "node:net";

import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
import { sendRaw, type RawResponse, type ServerHandle } from "../harness.js";

function postRequestLines(apiKey: string | null, body: string): string {
  return (
    "POST /v1/chat/completions HTTP/1.1\n" +
    "Host: 127.0.0.1\n" +
    "Content-Type: application/json\n" +
    `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\n` +
    `Authorization: Bearer ${apiKey ?? ""}\n` +
    "Connection: close\n"
  );
}

function streamBody(marker: string): string {
  // No space between "SCEN:" and the marker — the fixture's marker regex
  // (`^SCEN:(\S+)`) captures only the first non-whitespace token; any
  // unrecognized marker falls through to its generic success path, which
  // echoes the marker itself back as content (FAKE-UPSTREAM-STREAM:<marker>).
  return JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: `SCEN:concurrent-${marker}` }],
    stream: true,
  });
}

const CHATCMPL_ID = /"id":\s*"(chatcmpl-[0-9a-f]{32})"/u;

function analyzeConcurrentStream(
  body: string,
  marker: string,
): { text: string; id: string | null; hasOwnContent: boolean; endsWithDone: boolean } {
  const id = CHATCMPL_ID.exec(body)?.[1] ?? null;
  const normalized = id === null ? body : body.replaceAll(id, "<ID>");
  const text = normalized.replaceAll(/"created":\s*\d+/gu, '"created":0');
  return {
    text,
    id,
    hasOwnContent: body.includes(`FAKE-UPSTREAM-STREAM:concurrent-${marker}`),
    endsWithDone: body.trimEnd().endsWith("data: [DONE]"),
  };
}

/** Reads until the role-delta chunk has arrived (proving the SSE stream is
 * genuinely open and the server has already committed bytes to the wire),
 * then destroys the socket — a real client disconnect mid-stream, not a
 * graceful close. */
function connectReadRoleDeltaThenDisconnect(
  port: number,
  requestLines: string,
  body: string,
): Promise<void> {
  return new Promise((resolveDisconnect, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(requestLines.replaceAll("\n", "\r\n") + "\r\n" + body);
    });
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("DISCONNECT_PROBE_TIMEOUT"));
    }, 8000);
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (/"role":\s*"assistant"/u.test(received)) {
        clearTimeout(timer);
        socket.destroy();
        resolveDisconnect();
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function checkIsolation(
  side: ServerHandle,
  upstream: FakeUpstream,
): Promise<{
  ok: boolean;
  checks: Record<string, boolean>;
  oracleLike: string;
  upstreamCount: number;
}> {
  const before = upstream.requests.length;
  const [responseA, responseB] = await Promise.all([
    sendRaw(side.port, postRequestLines(side.apiKey, streamBody("A")), streamBody("A")),
    sendRaw(side.port, postRequestLines(side.apiKey, streamBody("B")), streamBody("B")),
  ]);
  const upstreamCount = upstream.requests.length - before;

  const analysisA = analyzeConcurrentStream(responseA.body, "A");
  const analysisB = analyzeConcurrentStream(responseB.body, "B");
  const idsDistinctOk =
    analysisA.id !== null && analysisB.id !== null && analysisA.id !== analysisB.id;
  const contentIsolatedOk =
    analysisA.hasOwnContent &&
    !responseA.body.includes("FAKE-UPSTREAM-STREAM:concurrent-B") &&
    analysisB.hasOwnContent &&
    !responseB.body.includes("FAKE-UPSTREAM-STREAM:concurrent-A");
  const doneOk = analysisA.endsWithDone && analysisB.endsWithDone;
  const checks = { idsDistinctOk, contentIsolatedOk, doneOk, upstreamCountOk: upstreamCount === 2 };
  const ok = Object.values(checks).every(Boolean);
  const sortedPair = [analysisA, analysisB].sort((a, b) =>
    a.text < b.text ? -1 : a.text > b.text ? 1 : 0,
  );
  return {
    ok,
    checks,
    oracleLike: JSON.stringify(sortedPair.map((entry) => entry.text)),
    upstreamCount,
  };
}

async function checkDisconnectRecovery(
  side: ServerHandle,
  upstream: FakeUpstream,
): Promise<{ ok: boolean; checks: Record<string, boolean>; followUp: RawResponse }> {
  const before = upstream.requests.length;
  const disconnectBody = streamBody("disconnect-drop");
  await connectReadRoleDeltaThenDisconnect(
    side.port,
    postRequestLines(side.apiKey, disconnectBody),
    disconnectBody,
  );
  // The role-delta chunk is written to the client BEFORE the server makes
  // its own upstream call (established by t11-chat-stream-post-open-error-
  // done — the role chunk survives even an upstream FAILURE), so seeing it
  // here does not guarantee the disconnected request's own upstream call
  // has landed yet; the disconnect itself doesn't cancel that in-flight
  // server-side work. Poll briefly rather than assume the ordering.
  const disconnectSettleDeadline = Date.now() + 4000;
  while (upstream.requests.length === before && Date.now() < disconnectSettleDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const afterDisconnect = upstream.requests.length;

  const followUpBody = streamBody("disconnect-followup");
  const followUp = await sendRaw(
    side.port,
    postRequestLines(side.apiKey, followUpBody),
    followUpBody,
  );
  const afterFollowUp = upstream.requests.length;

  const checks = {
    // Exactly one upstream call for the disconnected request itself — the
    // disconnect happens on the CLIENT'S downstream socket, after the
    // server already opened its own upstream call, so it is expected.
    disconnectMadeExactlyOneUpstreamCallOk: afterDisconnect - before === 1,
    followUpCompletesNormallyOk:
      followUp.statusLine.includes(" 200 ") &&
      followUp.body.trimEnd().endsWith("data: [DONE]") &&
      followUp.body.includes(`FAKE-UPSTREAM-STREAM:concurrent-disconnect-followup`),
    // The follow-up made exactly one MORE upstream call — no extra/ghost
    // request from the disconnected one (assertion 66b).
    noExtraUpstreamRequestOk: afterFollowUp - afterDisconnect === 1,
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, checks, followUp };
}

export async function run(
  oracle: ServerHandle,
  candidate: ServerHandle,
  upstream: FakeUpstream,
): Promise<{
  projection: unknown;
  rawEvidence: unknown;
  match: boolean;
  differences: unknown[];
  expectedUpstreamRequests: number;
}> {
  const oracleIsolation = await checkIsolation(oracle, upstream);
  const candidateIsolation = await checkIsolation(candidate, upstream);
  const isolationBilateralOk = oracleIsolation.oracleLike === candidateIsolation.oracleLike;

  const oracleDisconnect = await checkDisconnectRecovery(oracle, upstream);
  const candidateDisconnect = await checkDisconnectRecovery(candidate, upstream);

  const upstreamAtEnd: UpstreamRequestRecord[] = [...upstream.requests];

  const checks = {
    oracleIsolationOk: oracleIsolation.ok,
    candidateIsolationOk: candidateIsolation.ok,
    isolationBilateralOk,
    oracleDisconnectOk: oracleDisconnect.ok,
    candidateDisconnectOk: candidateDisconnect.ok,
  };
  const match = Object.values(checks).every(Boolean);
  const differences = match
    ? []
    : [
        {
          id: "isolation",
          oracle: oracleIsolation.checks,
          candidate: candidateIsolation.checks,
          isolationBilateralOk,
        },
        {
          id: "disconnect",
          oracle: oracleDisconnect.checks,
          candidate: candidateDisconnect.checks,
        },
      ];

  return {
    projection: {
      checks,
      note: "Assertion 66's third clause (no listener/process/temp remains after the case) is structurally guaranteed by startServer/stopAndCleanup's own lifecycle, exercised identically by every scenario in this matrix, not independently re-proven here.",
    },
    rawEvidence: {
      isolationUpstreamCounts: {
        oracle: oracleIsolation.upstreamCount,
        candidate: candidateIsolation.upstreamCount,
      },
      disconnectFollowUp: {
        oracle: oracleDisconnect.followUp,
        candidate: candidateDisconnect.followUp,
      },
      upstreamAtEnd,
    },
    match,
    differences,
    // 2 (oracle isolation pair) + 2 (candidate isolation pair) + 1+1
    // (oracle disconnect + follow-up) + 1+1 (candidate disconnect +
    // follow-up) = 8.
    expectedUpstreamRequests: 8,
  };
}
