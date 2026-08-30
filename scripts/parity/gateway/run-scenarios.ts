#!/usr/bin/env node
// The T12 [socket-bilateral] scenario runner: launches the real oracle and
// the real candidate side by side, on ephemeral ports, and probes BOTH
// with nothing but the raw HTTP/RFC6455 clients built in this ticket --
// no ws library, no TestClient, no in-process shortcuts. This is the
// Evaluator-facing evidence class assertion 67 requires as principal
// proof; everything under tests/gateway/ is this session's own TDD
// confidence, not a substitute for this.
//
// Verdict policy: the PRIMARY signal for every scenario is bilateral
// equality -- oracle's own observed result is ground truth, and the
// candidate must match it on the facts the scenario reads. A handful of
// scenarios additionally assert a literal expected value (e.g. the 4401
// close code, a binding contract decision this session implemented
// directly) as defense-in-depth against both sides coincidentally
// drifting the same wrong way; that check never substitutes for the
// bilateral one.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startFakeUpstream, type FakeUpstream } from "./fake-upstream.js";
import { launchCandidateDashboard, type LaunchedGatewayProcess } from "./launch-candidate.js";
import { launchOracleDashboard, type LaunchedOracleProcess, verifyOracleGuard } from "./launch-oracle.js";
import { sendRawHttpRequest, type RawHttpResponse } from "./raw-http-client.js";
import { connectRawWs, decodeCloseFrame, WS_OPCODE, type RawWsClient } from "./raw-ws-client.js";

const projectRoot = resolve(import.meta.dirname, "../../..");
const evidenceRoot = resolve(projectRoot, ".parity-evidence/t12");
mkdirSync(evidenceRoot, { recursive: true });

interface ScenarioContext {
  readonly oraclePort: number;
  readonly candidatePort: number;
}

interface ScenarioResult {
  readonly id: string;
  readonly verdict: "match" | "divergent" | "error";
  readonly detail?: string;
}

type ScenarioFn = (ctx: ScenarioContext) => Promise<ScenarioResult>;

function jsonBody(response: RawHttpResponse): unknown {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    return response.body.toString("utf8");
  }
}

function headerValue(response: RawHttpResponse, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of response.headers) if (key.toLowerCase() === lower) return value;
  return null;
}

function divergent(id: string, detail: string): ScenarioResult {
  return { id, verdict: "divergent", detail };
}

async function probeBoth(
  ctx: ScenarioContext,
  path: string,
  headers: readonly (readonly [string, string])[],
  method = "GET",
): Promise<{ readonly oracle: RawHttpResponse; readonly candidate: RawHttpResponse }> {
  const [oracle, candidate] = await Promise.all([
    sendRawHttpRequest("127.0.0.1", ctx.oraclePort, {
      method,
      path,
      headers: [...headers, ["Host", "127.0.0.1"], ["Connection", "close"]],
    }),
    sendRawHttpRequest("127.0.0.1", ctx.candidatePort, {
      method,
      path,
      headers: [...headers, ["Host", "127.0.0.1"], ["Connection", "close"]],
    }),
  ]);
  return { oracle, candidate };
}

async function probeBothUpgrade(
  ctx: ScenarioContext,
  path: string,
): Promise<{ readonly oracleStatus: number; readonly candidateStatus: number }> {
  const headers: readonly (readonly [string, string])[] = [
    ["Host", "127.0.0.1"],
    ["Connection", "Upgrade"],
    ["Upgrade", "websocket"],
    ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
    ["Sec-WebSocket-Version", "13"],
  ];
  const [oracle, candidate] = await Promise.all([
    sendRawHttpRequest("127.0.0.1", ctx.oraclePort, { method: "GET", path, headers }),
    sendRawHttpRequest("127.0.0.1", ctx.candidatePort, { method: "GET", path, headers }),
  ]);
  return { oracleStatus: oracle.status, candidateStatus: candidate.status };
}

// -- [socket-bilateral] scenarios, secure mode (auth enforced) -------------

const SECURE_SCENARIOS: ScenarioFn[] = [
  // t12-surface-exact-routes-and-openapi-schema (assertion 13, 17)
  async (ctx) => {
    const id = "t12-surface-exact-routes-and-openapi-schema";
    const { oracle, candidate } = await probeBoth(ctx, "/openapi.json", []);
    if (oracle.status !== candidate.status) {
      return divergent(id, `status oracle=${String(oracle.status)} candidate=${String(candidate.status)}`);
    }
    if (oracle.status !== 200) return divergent(id, `expected 200, both sides got ${String(oracle.status)}`);
    const oraclePaths = Object.keys((jsonBody(oracle) as { paths: Record<string, unknown> }).paths).sort();
    const candidatePaths = Object.keys(
      (jsonBody(candidate) as { paths: Record<string, unknown> }).paths,
    ).sort();
    if (JSON.stringify(oraclePaths) !== JSON.stringify(candidatePaths)) {
      return divergent(id, `paths oracle=${JSON.stringify(oraclePaths)} candidate=${JSON.stringify(candidatePaths)}`);
    }
    return { id, verdict: "match" };
  },

  // t12-auth-order-precedes-routing (assertion 14/L1): no token, unknown path
  async (ctx) => {
    const id = "t12-auth-order-precedes-routing";
    const { oracle, candidate } = await probeBoth(ctx, "/api/does-not-exist", []);
    if (oracle.status !== candidate.status) {
      return divergent(id, `no-token oracle=${String(oracle.status)} candidate=${String(candidate.status)}`);
    }
    if (oracle.status !== 401) return divergent(id, `expected 401, both sides got ${String(oracle.status)}`);
    return { id, verdict: "match" };
  },

  // t12-docs-open-and-no-spa (assertion 17/L11): docs bypasses auth, root 404s
  async (ctx) => {
    const id = "t12-docs-open-and-no-spa";
    const root = await probeBoth(ctx, "/", []);
    if (root.oracle.status !== root.candidate.status) {
      return divergent(id, `root oracle=${String(root.oracle.status)} candidate=${String(root.candidate.status)}`);
    }
    const docs = await probeBoth(ctx, "/docs", []);
    if (docs.oracle.status !== docs.candidate.status) {
      return divergent(id, `docs oracle=${String(docs.oracle.status)} candidate=${String(docs.candidate.status)}`);
    }
    if (docs.oracle.status !== 200) return divergent(id, `expected docs=200, both sides got ${String(docs.oracle.status)}`);
    return { id, verdict: "match" };
  },

  // t12-options-head-enumeration (assertion 16/L12): pure bilateral, no
  // hard-coded expectation -- the exact interaction between auth-ordering
  // and OPTIONS/HEAD semantics is read off the oracle itself, not assumed.
  async (ctx) => {
    const id = "t12-options-head-enumeration";
    const knownOptions = await probeBoth(ctx, "/api/status", [], "OPTIONS");
    if (knownOptions.oracle.status !== knownOptions.candidate.status) {
      return divergent(
        id,
        `OPTIONS /api/status oracle=${String(knownOptions.oracle.status)} candidate=${String(knownOptions.candidate.status)}`,
      );
    }
    const unknownOptions = await probeBoth(ctx, "/api/does-not-exist", [], "OPTIONS");
    if (unknownOptions.oracle.status !== unknownOptions.candidate.status) {
      return divergent(
        id,
        `OPTIONS unknown oracle=${String(unknownOptions.oracle.status)} candidate=${String(unknownOptions.candidate.status)}`,
      );
    }
    return { id, verdict: "match" };
  },

  // t12-location-host-header-derivation-and-arbitrary-host (L23): bilateral
  // on whatever Location the oracle actually derives from an attacker-
  // controlled Host header.
  async (ctx) => {
    const id = "t12-location-host-header-derivation-and-arbitrary-host";
    const [oracle, candidate] = await Promise.all([
      sendRawHttpRequest("127.0.0.1", ctx.oraclePort, {
        method: "GET",
        path: "/docs/",
        headers: [["Host", "evil.example:8080"], ["Connection", "close"]],
      }),
      sendRawHttpRequest("127.0.0.1", ctx.candidatePort, {
        method: "GET",
        path: "/docs/",
        headers: [["Host", "evil.example:8080"], ["Connection", "close"]],
      }),
    ]);
    if (oracle.status !== candidate.status) {
      return divergent(id, `status oracle=${String(oracle.status)} candidate=${String(candidate.status)}`);
    }
    const oracleLocation = headerValue(oracle, "location");
    const candidateLocation = headerValue(candidate, "location");
    if (oracleLocation !== candidateLocation) {
      return divergent(id, `location oracle=${String(oracleLocation)} candidate=${String(candidateLocation)}`);
    }
    return { id, verdict: "match" };
  },

  // t12-ws-handshake-always-101-then-close-4401 (assertion 19, binding
  // decision): the ONLY scenario where a literal expected value (4401,
  // empty reason) is asserted with confidence, since both sides implement
  // this exact binding decision -- oracle as the T12 baseline behavior,
  // candidate as this session's own product code.
  async (ctx) => {
    const id = "t12-ws-handshake-always-101-then-close-4401";
    const [oracleWs, candidateWs] = await Promise.all([
      connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
      connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
    ]);
    if (oracleWs.handshake.status !== candidateWs.handshake.status) {
      return divergent(
        id,
        `handshake oracle=${String(oracleWs.handshake.status)} candidate=${String(candidateWs.handshake.status)}`,
      );
    }
    if (oracleWs.handshake.status !== 101) {
      return divergent(id, `expected handshake=101, both sides got ${String(oracleWs.handshake.status)}`);
    }
    const [oracleFrame, candidateFrame] = await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]);
    oracleWs.close();
    candidateWs.close();
    if (oracleFrame.opcode !== candidateFrame.opcode) {
      return divergent(id, `opcode oracle=${String(oracleFrame.opcode)} candidate=${String(candidateFrame.opcode)}`);
    }
    if (oracleFrame.opcode !== WS_OPCODE.close) {
      return divergent(id, `expected a close frame, both sides sent opcode ${String(oracleFrame.opcode)}`);
    }
    const oracleClose = decodeCloseFrame(oracleFrame.payload);
    const candidateClose = decodeCloseFrame(candidateFrame.payload);
    if (oracleClose.code !== candidateClose.code || oracleClose.reason !== candidateClose.reason) {
      return divergent(
        id,
        `close oracle=${String(oracleClose.code)}/${oracleClose.reason} candidate=${String(candidateClose.code)}/${candidateClose.reason}`,
      );
    }
    if (oracleClose.code !== 4401 || oracleClose.reason !== "") {
      return divergent(id, `expected close=4401/"", both sides sent ${String(oracleClose.code)}/${oracleClose.reason}`);
    }
    return { id, verdict: "match" };
  },

  // t12-ws-path-sweep-unauthenticated (assertion 23/L3): bilateral across a
  // sweep of near-miss WS paths, no hard-coded status since the exact code
  // (403 vs 404 vs 401) per near-miss path is the oracle's own fact.
  async (ctx) => {
    const id = "t12-ws-path-sweep-unauthenticated";
    const paths = ["/api/websocket", "/api/ws/", "/api/pty", "/api/pub", "/api/events"];
    const results = await Promise.all(paths.map(async (path) => [path, await probeBothUpgrade(ctx, path)] as const));
    for (const [path, result] of results) {
      if (result.oracleStatus !== result.candidateStatus) {
        return divergent(id, `${path}: oracle=${String(result.oracleStatus)} candidate=${String(result.candidateStatus)}`);
      }
    }
    return { id, verdict: "match" };
  },
];

// -- [socket-bilateral] scenarios, insecure mode (auth bypassed) -----------
// `--insecure` is the only way this harness has, today, to reach RPC
// methods without first minting and threading a valid session token
// through the raw client -- so these scenarios trade auth coverage (fully
// exercised above) for RPC-body coverage.

const INSECURE_SCENARIOS: ScenarioFn[] = [
  // t12-rpc-session-lifecycle (assertion 27-32 subset): session.create,
  // session.list over a real RFC6455 connection, bilateral on the JSON-RPC
  // envelope shape and any error field each side returns.
  async (ctx) => {
    const id = "t12-rpc-session-lifecycle";
    const [oracleWs, candidateWs] = await Promise.all([
      connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
      connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
    ]);
    try {
      if (oracleWs.handshake.status !== 101 || candidateWs.handshake.status !== 101) {
        return divergent(
          id,
          `handshake oracle=${String(oracleWs.handshake.status)} candidate=${String(candidateWs.handshake.status)}`,
        );
      }
      // Drain the gateway.ready event both sides send right after connect.
      await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]);

      const createDivergence = await rpcRoundTrip(oracleWs, candidateWs, {
        jsonrpc: "2.0",
        id: 1,
        method: "session.create",
        params: {},
      });
      if (createDivergence !== null) return divergent(id, `session.create: ${createDivergence.detail}`);

      const listDivergence = await rpcRoundTrip(oracleWs, candidateWs, {
        jsonrpc: "2.0",
        id: 2,
        method: "session.list",
        params: {},
      });
      if (listDivergence !== null) return divergent(id, `session.list: ${listDivergence.detail}`);

      return { id, verdict: "match" };
    } finally {
      oracleWs.close();
      candidateWs.close();
    }
  },
];

interface RpcDivergence {
  readonly detail: string;
}

// Sends the SAME JSON-RPC request to both raw WS connections and compares
// the two response envelopes structurally: same field set, and an
// identical error field when either side reports one. Instance-specific
// values inside `result` (session ids, timestamps) are intentionally not
// compared here -- that would require oracle/candidate-specific
// normalization this first slice doesn't yet build.
async function rpcRoundTrip(
  oracleWs: RawWsClient,
  candidateWs: RawWsClient,
  request: { readonly jsonrpc: "2.0"; readonly id: number; readonly method: string; readonly params: unknown },
): Promise<RpcDivergence | null> {
  oracleWs.sendText(JSON.stringify(request));
  candidateWs.sendText(JSON.stringify(request));
  const [oracleFrame, candidateFrame] = await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]);
  if (oracleFrame.opcode !== candidateFrame.opcode) {
    return { detail: `opcode oracle=${String(oracleFrame.opcode)} candidate=${String(candidateFrame.opcode)}` };
  }
  const oracleEnvelope = JSON.parse(oracleFrame.payload.toString("utf8")) as Record<string, unknown>;
  const candidateEnvelope = JSON.parse(candidateFrame.payload.toString("utf8")) as Record<string, unknown>;
  const oracleShape = Object.keys(oracleEnvelope).sort();
  const candidateShape = Object.keys(candidateEnvelope).sort();
  if (JSON.stringify(oracleShape) !== JSON.stringify(candidateShape)) {
    return {
      detail: `envelope shape oracle=${JSON.stringify(oracleShape)} candidate=${JSON.stringify(candidateShape)}`,
    };
  }
  if (JSON.stringify(oracleEnvelope.error) !== JSON.stringify(candidateEnvelope.error)) {
    return {
      detail: `error oracle=${JSON.stringify(oracleEnvelope.error)} candidate=${JSON.stringify(candidateEnvelope.error)}`,
    };
  }
  return null;
}

async function runPhase(
  label: string,
  scenarios: readonly ScenarioFn[],
  oracleOpts: { readonly insecure: boolean },
  candidateArgvExtra: readonly string[],
  fakeUpstream: FakeUpstream,
): Promise<ScenarioResult[]> {
  let oracle: LaunchedOracleProcess | undefined;
  let candidate: LaunchedGatewayProcess | undefined;
  const results: ScenarioResult[] = [];
  try {
    const home = mkdtempSync(join(tmpdir(), `lohra-t12-candidate-home-${label}-`));
    [oracle, candidate] = await Promise.all([
      launchOracleDashboard({ fakeUpstreamPort: fakeUpstream.port, insecure: oracleOpts.insecure }),
      launchCandidateDashboard({
        argv: ["--provider", "anthropic", ...candidateArgvExtra],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          LOHRA_HOME: home,
          ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
        },
        cwd: home,
        bootTimeoutMs: 20_000,
      }),
    ]);
    const ctx: ScenarioContext = { oraclePort: oracle.port, candidatePort: candidate.port };
    for (const scenario of scenarios) {
      try {
        results.push(await scenario(ctx));
      } catch (error) {
        results.push({
          id: `${label}:unknown`,
          verdict: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await oracle?.kill();
    await candidate?.kill();
  }
  return results;
}

async function main(): Promise<void> {
  const guard = verifyOracleGuard();
  if (!guard.ok) {
    console.error(`ORACLE_GUARD_FAILED:${guard.detail}`);
    process.exitCode = 2;
    return;
  }

  const fakeUpstream: FakeUpstream = await startFakeUpstream();
  let results: ScenarioResult[];
  try {
    const secureResults = await runPhase("secure", SECURE_SCENARIOS, { insecure: false }, [], fakeUpstream);
    const insecureResults = await runPhase(
      "insecure",
      INSECURE_SCENARIOS,
      { insecure: true },
      ["--insecure"],
      fakeUpstream,
    );
    results = [...secureResults, ...insecureResults];
  } finally {
    await fakeUpstream.close();
  }

  const evidencePath = join(evidenceRoot, "run-scenarios.json");
  writeFileSync(evidencePath, JSON.stringify({ results }, null, 2));

  const failed = results.filter((result) => result.verdict !== "match");
  for (const result of results) {
    const marker = result.verdict === "match" ? "PASS" : "FAIL";
    console.log(`[${marker}] ${result.id}${result.detail !== undefined ? ` -- ${result.detail}` : ""}`);
  }
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} scenarios match.`);
  console.log(`Evidence: ${evidencePath}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
