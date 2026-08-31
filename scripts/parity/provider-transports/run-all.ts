#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import Database from "better-sqlite3";
import { canonicalJson } from "../canonical.js";

type Manifest = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly layer: "turno-publico";
  readonly transport: "anthropic" | "chat" | "codex" | "pack";
  readonly fixture: string;
  readonly mode: string;
  readonly argv: readonly string[];
  readonly expectedRequests: number;
};
type RequestRecord = {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly rawBody: string;
};

const root = resolve(import.meta.dirname, "../../..");
const oracle = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/.oracle-venv/bin/lohra";
const oracleCheckout = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/lohra";
const candidateCli = resolve(root, "dist/cli.js");
const candidatePreload = resolve(import.meta.dirname, "candidate-preload.mjs");
const packSmoke = resolve(import.meta.dirname, "pack-smoke.mjs");
const pythonSentinel = resolve(import.meta.dirname, "python-sentinel");
const manifestsRoot = resolve(root, "scripts/parity/manifests/t10");
const evidenceRoot = resolve(root, ".parity-evidence/t10");
mkdirSync(evidenceRoot, { recursive: true });

function checkedOutput(executable: string, args: readonly string[], cwd = root): string {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0)
    throw new Error(`T10_GUARD_FAILED:${executable}:${String(result.status)}:${result.stderr}`);
  return result.stdout;
}

const oracleCommit = checkedOutput("git", ["rev-parse", "HEAD"], oracleCheckout).trim();
if (oracleCommit !== "16b4785d803ad0ca364a8a67346a04f949fbf592")
  throw new Error(`T10_ORACLE_PIN:${oracleCommit}`);
if (checkedOutput("git", ["status", "--porcelain"], oracleCheckout) !== "")
  throw new Error("T10_ORACLE_DIRTY");
if (checkedOutput(oracle, ["--version"]) !== "lohra 0.0.11\n")
  throw new Error("T10_ORACLE_VERSION");
const targetSha = checkedOutput("git", ["rev-parse", "HEAD"]).trim();

let active: { manifest: Manifest; side: "oracle" | "candidate"; requests: RequestRecord[] } | null =
  null;

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
function sse(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const eventType = (event: unknown): string => {
    const value = (event as { type?: unknown }).type;
    return typeof value === "string" ? value : "message";
  };
  response.end(
    `${events.map((event) => `event: ${eventType(event)}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function anthropic(
  manifest: Manifest,
  index: number,
  stream: boolean,
  response: ServerResponse,
): void {
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  let payload: Record<string, unknown>;
  if (manifest.fixture === "thinking-resume" && index === 0)
    payload = {
      content: [
        { type: "thinking", signature: "SIG-T10", thinking: "THINK-T10" },
        { type: "text", text: "FIRST" },
      ],
      stop_reason: "end_turn",
      usage: usage(4, 2),
    };
  else if (manifest.fixture === "tool" && index === 0)
    payload = {
      content: [
        { type: "tool_use", id: "call-1", name: "read_file", input: { path: "tool-target.txt" } },
      ],
      stop_reason: "tool_use",
      usage: usage(4, 2),
    };
  else if (manifest.fixture === "pause" && index < 2)
    payload = {
      content: [{ type: "text", text: index === 0 ? "PART1" : "PART2" }],
      stop_reason: "pause_turn",
      usage: usage(index === 0 ? 10 : 0, index === 0 ? 4 : 0),
    };
  else if (manifest.fixture === "max")
    payload = {
      content: [{ type: "text", text: "LIMIT" }],
      stop_reason: "max_tokens",
      usage: usage(3, 1),
    };
  else if (manifest.fixture === "refusal")
    payload = {
      content: [{ type: "text", text: "REFUSED" }],
      stop_reason: "refusal",
      usage: usage(3, 1),
    };
  else
    payload = {
      content: [
        {
          type: "text",
          text:
            manifest.fixture === "pause"
              ? "DONE"
              : manifest.fixture === "thinking-resume"
                ? "SECOND"
                : manifest.fixture === "tool"
                  ? "TOOL-DONE"
                  : "ANTHROPIC-OK",
        },
      ],
      stop_reason: "end_turn",
      usage: usage(manifest.fixture === "pause" ? 6 : 3, manifest.fixture === "pause" ? 3 : 1),
    };
  if (!stream) {
    if (manifest.fixture === "tool" && index === 0) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        '{"content":[{"type":"tool_use","id":"call-1","name":"terminal","input":{"command":"sleep 2","timeout":1.0,"since_ns":1788107097189000000}}],"stop_reason":"tool_use","usage":{"input_tokens":4,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
      );
      return;
    }
    json(response, payload);
    return;
  }
  const firstText = (payload.content as Array<Record<string, unknown>>)[0]?.text;
  const text = typeof firstText === "string" ? firstText : "ANTHROPIC-OK";
  sse(response, [
    {
      type: "message_start",
      message: {
        id: "msg-t10",
        type: "message",
        role: "assistant",
        model: "stub-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    {
      type: "message_delta",
      delta: { stop_reason: payload.stop_reason },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

function responses(manifest: Manifest, index: number, response: ServerResponse): void {
  if (manifest.fixture === "failed") {
    sse(response, [
      {
        type: "response.failed",
        response: { status: "failed", error: { code: "usage_limit_reached", message: "quota" } },
      },
    ]);
    return;
  }
  const output: Record<string, unknown>[] = [];
  if (manifest.fixture === "tool-replay" && index === 0) {
    output.push({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "why" }],
      encrypted_content: "ENC-T10",
    });
    output.push({
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: '{"path":"tool-target.txt"}',
    });
  } else {
    output.push({
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: manifest.fixture === "tool-replay" ? "CODEX-DONE" : "CODEX-OK",
        },
      ],
    });
  }
  sse(response, [
    ...output.map((item) => ({ type: "response.output_item.done", item })),
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
  ]);
}

function chat(manifest: Manifest, index: number, stream: boolean, response: ServerResponse): void {
  const message: Record<string, unknown> = { content: "CHAT-OK" };
  let finish = "stop";
  if (manifest.fixture === "reasoning") message.reasoning_content = "CHAT-THINK";
  if (manifest.fixture === "tool" && index === 0) {
    message.content = null;
    message.tool_calls = [
      {
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"tool-target.txt"}' },
      },
    ];
    finish = "tool_calls";
  } else if (manifest.fixture === "tool") message.content = "CHAT-DONE";
  if (manifest.fixture === "pause") finish = "pause";
  const payload = {
    choices: [{ message, finish_reason: finish }],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  };
  if (!stream) {
    json(response, payload);
    return;
  }
  sse(response, [
    { choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: payload.usage },
  ]);
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    if (active === null) {
      json(response, { error: "no active scenario" }, 500);
      return;
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const headers = Object.fromEntries(
      Object.entries(request.headers).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]],
      ),
    );
    const record = {
      method: request.method ?? "",
      path: request.url ?? "",
      headers,
      body: parsed,
      rawBody: text,
    };
    active.requests.push(record);
    const index = active.requests.length - 1;
    const stream = parsed.stream === true;
    if ((request.url ?? "").endsWith("/messages"))
      anthropic(active.manifest, index, stream, response);
    else if ((request.url ?? "").endsWith("/responses"))
      responses(active.manifest, index, response);
    else chat(active.manifest, index, stream, response);
  });
});

function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: Record<string, string>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveRun({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function materialize(
  runtimeRoot: string,
  manifest: Manifest,
): { home: string; profile: string; cwd: string; codexHome: string } {
  const home = join(runtimeRoot, "home");
  const profile = join(runtimeRoot, "profile");
  const cwd = join(runtimeRoot, "project");
  const codexHome = join(runtimeRoot, "codex");
  for (const path of [home, profile, cwd, codexHome, join(runtimeRoot, "tmp")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(cwd, "tool-target.txt"), "TOOL-TARGET-T10\n", "utf8");
  if (manifest.transport === "codex") {
    writeFileSync(
      join(profile, "auth.json"),
      JSON.stringify({
        openai: { auth_mode: "subscription", acknowledged_tos_risk: true, preference: "auto" },
      }),
      "utf8",
    );
    writeFileSync(
      join(profile, "oauth.json"),
      JSON.stringify({
        access_token: "DUMMY-ACCESS-T10",
        refresh_token: "DUMMY-REFRESH-T10",
        account_id: "DUMMY-ACCOUNT-T10",
        expires_at: 2_000_000_000,
      }),
      "utf8",
    );
    if (manifest.mode === "default-model")
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
  }
  return { home, profile, cwd, codexHome };
}

function database(path: string): unknown {
  try {
    const db = new Database(path, { readonly: true });
    const messages = db
      .prepare(
        "SELECT role, content, finish_reason, reasoning, reasoning_details, tool_calls FROM messages ORDER BY id",
      )
      .all();
    const sessions = db
      .prepare(
        "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, api_call_count, priced_call_count FROM sessions ORDER BY id",
      )
      .all();
    db.close();
    return { messages, sessions };
  } catch {
    return null;
  }
}

function treeSnapshot(rootPath: string): readonly Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      const pathName = relative(rootPath, absolute);
      if (entry.isDirectory()) {
        entries.push({ path: pathName, type: "directory" });
        visit(absolute);
      } else if (entry.isFile()) {
        const content = readFileSync(absolute);
        entries.push({
          path: pathName,
          type: "file",
          size: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } else {
        entries.push({ path: pathName, type: "other" });
      }
    }
  };
  visit(rootPath);
  return entries;
}

function projectedEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const secret = /(?:KEY|TOKEN|ACCOUNT)/u;
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key,
      secret.test(key) ? "<REDACTED>" : value,
    ]),
  );
}

function normalizedOutput(stdout: string): unknown {
  const pretty = stdout.indexOf('{\n  "session_id"');
  const compact = stdout.indexOf('{"session_id"');
  const offsets = [pretty, compact].filter((value) => value >= 0);
  const offset = offsets.length > 0 ? Math.min(...offsets) : -1;
  if (offset < 0) return stdout;
  try {
    const parsed = JSON.parse(stdout.slice(offset)) as Record<string, unknown>;
    parsed.session_id = "<SESSION>";
    delete parsed.session;
    return parsed;
  } catch {
    return stdout;
  }
}

function normalizeRuntimePaths<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value).replace(
      /\/(?:private\/var\/folders\/.*?\/|tmp\/)lohra-t10-(?:oracle|candidate)-[^/"\\]+/gu,
      "<RUNTIME>",
    ),
  ) as T;
}

/** The system prompt's "Today's date is YYYY-MM-DD." reaches the hashed
 * projection through several paths (an upstream request body, a stored
 * system message row in `database.messages`, possibly the CLI's own
 * stdout) — normalizing the whole projection object in one pass, right
 * before hashing, catches all of them without having to enumerate each
 * field individually. Anchored to the exact sentence (not a bare date
 * pattern) so it can't accidentally swallow an unrelated YYYY-MM-DD-shaped
 * value elsewhere in the projection. */
function normalizeToday<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value).replace(/Today's date is \d{4}-\d{2}-\d{2}\./gu, "Today's date is <DATE>."),
  ) as T;
}

function projectedRequests(records: readonly RequestRecord[]): unknown {
  return records.map((record) => ({
    method: record.method,
    path: record.path,
    headers: Object.fromEntries(
      [
        "authorization",
        "x-api-key",
        "anthropic-version",
        "originator",
        "chatgpt-account-id",
        "content-type",
      ].flatMap((name) =>
        record.headers[name] === undefined
          ? []
          : [
              [
                name,
                ["authorization", "x-api-key", "chatgpt-account-id"].includes(name)
                  ? "<REDACTED>"
                  : record.headers[name],
              ],
            ],
      ),
    ),
    body: normalizeRuntimePaths(record.body),
    timeoutToken:
      record.rawBody.match(/"timeout"\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[1] ??
      null,
    sinceNsToken: record.rawBody.match(/"since_ns"\s*:\s*(-?(?:0|[1-9]\d*))/u)?.[1] ?? null,
  }));
}

async function executeSide(
  side: "oracle" | "candidate",
  manifest: Manifest,
  loopback: string,
): Promise<{
  process: { exitCode: number | null; stdout: string; stderr: string };
  requests: RequestRecord[];
  database: unknown;
  environment: Record<string, string>;
  tree: readonly Record<string, unknown>[];
}> {
  const runtimeRoot = mkdtempSync(join(tmpdir(), `lohra-t10-${side}-`));
  try {
    const paths = materialize(runtimeRoot, manifest);
    const env: Record<string, string> = {
      PATH: side === "oracle" ? `${resolve(oracle, "..")}:/usr/bin:/bin` : "/usr/bin:/bin",
      PYTHONUTF8: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      TZ: "UTC",
      COLUMNS: "80",
      NO_COLOR: "1",
      HOME: paths.home,
      LOHRA_HOME: paths.profile,
      CODEX_HOME: paths.codexHome,
      TMPDIR: join(runtimeRoot, "tmp"),
      LOHRA_T10_LOOPBACK: loopback,
      ...(side === "oracle"
        ? { PYTHONPATH: `${pythonSentinel}:${join(oracleCheckout, "backend")}` }
        : {}),
      ...(manifest.transport === "anthropic" && manifest.fixture !== "no-key"
        ? { ANTHROPIC_API_KEY: "DUMMY-ANTHROPIC-T10" }
        : {}),
      ...(manifest.transport === "chat" && manifest.fixture !== "no-key"
        ? { OPENAI_API_KEY: "DUMMY-OPENAI-T10" }
        : {}),
    };
    const requests: RequestRecord[] = [];
    active = { manifest, side, requests };
    let processRecord;
    if (manifest.transport === "pack") {
      processRecord = { exitCode: 0, stdout: JSON.stringify({ pack: true }), stderr: "" };
    } else if (manifest.mode === "resume") {
      const firstArgs = [...manifest.argv];
      const first =
        side === "oracle"
          ? await run(oracle, firstArgs, paths.cwd, env)
          : await run(
              process.execPath,
              ["--import", candidatePreload, candidateCli, ...firstArgs],
              paths.cwd,
              env,
            );
      const parsed = JSON.parse(first.stdout) as { session_id: string };
      const secondArgs = [...manifest.argv, "--session", parsed.session_id];
      const second =
        side === "oracle"
          ? await run(oracle, secondArgs, paths.cwd, env)
          : await run(
              process.execPath,
              ["--import", candidatePreload, candidateCli, ...secondArgs],
              paths.cwd,
              env,
            );
      processRecord = { ...second, stderr: first.stderr + second.stderr };
    } else {
      processRecord =
        side === "oracle"
          ? await run(oracle, manifest.argv, paths.cwd, env)
          : await run(
              process.execPath,
              ["--import", candidatePreload, candidateCli, ...manifest.argv],
              paths.cwd,
              env,
            );
    }
    return {
      process: processRecord,
      requests: structuredClone(requests),
      database: database(join(paths.profile, "state.db")),
      environment: projectedEnvironment(env),
      tree: treeSnapshot(runtimeRoot),
    };
  } finally {
    active = null;
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("T10_LISTEN_FAILED");
const loopback = `http://127.0.0.1:${String(address.port)}`;
let failures = 0;
const projections: Array<{ id: string; sha: string; match: boolean }> = [];
try {
  const names = readdirSync(manifestsRoot)
    .filter((name) => name.startsWith("t10-") && name.endsWith(".json"))
    .sort();
  for (const name of names) {
    const manifestText = readFileSync(join(manifestsRoot, name), "utf8");
    const manifest = JSON.parse(manifestText) as Manifest;
    const parsedManifest = JSON.parse(manifestText) as unknown;
    if (manifest.transport === "pack") {
      const packRun = await run(process.execPath, [packSmoke], root, {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? tmpdir(),
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        TZ: "UTC",
        NO_COLOR: "1",
      });
      let packValue: Record<string, unknown> = {};
      try {
        packValue = JSON.parse(packRun.stdout) as Record<string, unknown>;
      } catch {
        packValue = { parseFailed: true };
      }
      // pack-smoke.mjs independently runs `git rev-parse HEAD` on the same
      // worktree this harness already resolved into `targetSha` above; the
      // two must agree, or the tarball wasn't actually built from the
      // checkout this run believes it's testing. This is the one genuine
      // check targetSha can fail: it stays a *raw* comparison (fed into
      // `match`, not hashOnly-scrubbed) so a real mismatch here still fails
      // the gate even after the digest below stops moving on it.
      const targetShaMatches = packValue.targetSha === targetSha;
      const match = packRun.exitCode === 0 && packValue.pass === true && targetShaMatches;
      if (!match) failures += 1;
      const projection = {
        classification: "candidate-package-only",
        oracle: "not-applicable",
        candidate: packValue,
      };
      // hashOnly: targetSha is `git rev-parse HEAD` of the very commit this
      // digest is meant to be compared ACROSS — it changes on every commit
      // by construction, so it was never a valid before/after invariant
      // (same family as T07's manifestSha256 and T08's date-in-hash
      // confounds). Scrubbed from the hashed view only; the real value
      // stays in `projection`/`raw` below for a human to read, and the
      // targetShaMatches check above still catches a genuine mismatch.
      const hashProjection = {
        ...projection,
        candidate: { ...packValue, targetSha: "<hashOnly:targetSha>" },
      };
      const sha = createHash("sha256").update(canonicalJson(hashProjection)).digest("hex");
      projections.push({ id: manifest.id, sha, match });
      writeFileSync(
        join(evidenceRoot, `${manifest.id}.json`),
        `${JSON.stringify({ schemaVersion: 1, manifest: parsedManifest, targetSha, raw: { exitCode: packRun.exitCode, stdout: packRun.stdout, stderr: packRun.stderr }, projection, differences: match ? [] : [{ candidate: packValue, targetShaMatches }], projectionSha256: sha }, null, 2)}\n`,
      );
      continue;
    }
    const oracleRun = await executeSide("oracle", manifest, loopback);
    const candidateRun = await executeSide("candidate", manifest, loopback);
    const safeOracleRun = { ...oracleRun, requests: projectedRequests(oracleRun.requests) };
    const safeCandidateRun = {
      ...candidateRun,
      requests: projectedRequests(candidateRun.requests),
    };
    const rawProjection = {
      oracle: {
        exitCode: oracleRun.process.exitCode,
        output: normalizedOutput(oracleRun.process.stdout),
        requests: projectedRequests(oracleRun.requests),
        database: oracleRun.database,
      },
      candidate: {
        exitCode: candidateRun.process.exitCode,
        output: normalizedOutput(candidateRun.process.stdout),
        requests: projectedRequests(candidateRun.requests),
        database: candidateRun.database,
      },
    };
    // The match/divergent verdict is computed from the UN-normalized
    // projection — normalizeToday only stabilizes the hashed/stored
    // projection against the daily date rollover; it must never blunt
    // detection of a genuine oracle/candidate content mismatch (including a
    // real date divergence, if the local-date fix ever regressed).
    const oracleProjection = canonicalJson(rawProjection.oracle);
    const candidateProjection = canonicalJson(rawProjection.candidate);
    const match =
      oracleProjection === candidateProjection &&
      oracleRun.requests.length === manifest.expectedRequests &&
      candidateRun.requests.length === manifest.expectedRequests;
    if (!match) failures += 1;
    const projection = normalizeToday(rawProjection);
    const sha = createHash("sha256").update(JSON.stringify(projection)).digest("hex");
    projections.push({ id: manifest.id, sha, match });
    writeFileSync(
      join(evidenceRoot, `${manifest.id}.json`),
      `${JSON.stringify({ schemaVersion: 1, manifest: parsedManifest, targetSha, raw: { oracle: safeOracleRun, candidate: safeCandidateRun }, projection, differences: match ? [] : [{ oracle: rawProjection.oracle, candidate: rawProjection.candidate }], projectionSha256: sha }, null, 2)}\n`,
    );
  }
} finally {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}
const digest = createHash("sha256")
  .update(projections.map(({ id, sha }) => `${id}=${sha}\n`).join(""))
  .digest("hex");
process.stdout.write(
  `${JSON.stringify({ suite: "t10-provider-transports-public", scenarios: projections.length, failures, digest, projections })}\n`,
);
process.exitCode = failures === 0 && projections.length === 19 ? 0 : 1;
