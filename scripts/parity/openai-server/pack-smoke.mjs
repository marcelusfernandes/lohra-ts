#!/usr/bin/env node
// Assertion 72: package smoke — pack a real tarball, install it into an
// EMPTY directory (no checkout imports reachable), spawn the packaged
// `lohra serve` binary against a loopback fixture, and exercise /health,
// auth, one non-stream and one stream request of EACH API (chat
// completions, Responses). Zero Python anywhere in the candidate runtime.
import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "../../..");
const evidenceRoot = resolve(projectRoot, ".parity-evidence/t11");
mkdirSync(evidenceRoot, { recursive: true });
const evidencePath = resolve(evidenceRoot, "t11-pack-smoke.json");
const runtimeRoot = mkdtempSync(join(tmpdir(), "lohra-t11-pack-"));

function checked(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `PACK_COMMAND_FAILED:${executable}:${String(result.status ?? result.signal)}:${result.stderr}`,
    );
  return result;
}

function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });
}

function waitForListening(port, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolveWait, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolveWait();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error("PACK_LISTEN_TIMEOUT"));
          return;
        }
        setTimeout(attempt, 25);
      });
    };
    attempt();
  });
}

function sendRaw(port, requestLines, body = "") {
  return new Promise((resolveSend, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(requestLines.replaceAll("\n", "\r\n") + "\r\n" + body);
    });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf("\r\n\r\n");
      const headerText = raw.subarray(0, headerEnd).toString("utf8");
      const [statusLine] = headerText.split("\r\n");
      resolveSend({
        statusLine: statusLine ?? "",
        body: raw.subarray(headerEnd + 4).toString("utf8"),
      });
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("PACK_RAW_TIMEOUT"));
    }, 8000);
  });
}

let success;
const requestCounts = { chat: 0 };
const upstream = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const stream =
      Buffer.concat(chunks).toString("utf8").includes('"stream":true') ||
      Buffer.concat(chunks).toString("utf8").includes('"stream": true');
    requestCounts.chat += 1;
    if (stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "PACK-STREAM" }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
          "data: [DONE]\n\n",
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "PACK-CHAT" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
});

let child;
try {
  const packDirectory = join(runtimeRoot, "pack");
  const installDirectory = join(runtimeRoot, "install");
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(installDirectory, { recursive: true });
  const packed = checked("npm", ["pack", "--json", "--pack-destination", packDirectory], {
    cwd: projectRoot,
  });
  const filename = JSON.parse(packed.stdout)[0]?.filename;
  if (typeof filename !== "string") throw new Error("PACK_TARBALL_MISSING");
  checked(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installDirectory,
      join(packDirectory, filename),
    ],
    { cwd: runtimeRoot },
  );
  const packageRoot = join(installDirectory, "node_modules/lohra-ts");
  const bin = join(installDirectory, "node_modules/.bin/lohra");
  if (!existsSync(bin)) throw new Error("PACK_BIN_MISSING");

  await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  const upstreamPort = upstream.address().port;
  const loopback = `http://127.0.0.1:${String(upstreamPort)}`;

  // Registers the fake provider against the INSTALLED package's OWN
  // dist/providers/index.js — a relative "../../../dist" import (as
  // candidate-launcher.mjs uses for the checkout) resolves to nothing from
  // an empty install directory.
  const preload = join(runtimeRoot, "pack-launcher.mjs");
  writeFileSync(
    preload,
    `import { registerProvider } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/providers/index.js")).href)};\n` +
      `registerProvider({ name: "packfake", apiMode: "chat_completions", aliases: [], displayName: "Pack fake", description: "", signupUrl: "", envVars: ["PACK_FAKE_API_KEY"], baseUrl: ${JSON.stringify(loopback)}, modelsUrl: "", requiresApiKey: true, supportsVision: false, fallbackModels: ["pack-model"], defaultMaxTokens: 8192, defaultAuxModel: "pack-model" });\n`,
  );

  const port = await allocatePort();
  const home = join(runtimeRoot, "home");
  const cwd = join(runtimeRoot, "project");
  const tmp = join(runtimeRoot, "tmp");
  for (const directory of [home, cwd, tmp]) mkdirSync(directory, { recursive: true });

  const apiKey = "T11-PACK-SMOKE-FIXED-KEY";
  child = spawn(
    process.execPath,
    ["--import", preload, bin, "serve", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd,
      env: {
        // No python anywhere on PATH — the candidate runtime must be
        // entirely zero-Python.
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        LOHRA_HOME: home,
        TMPDIR: tmp,
        TZ: "UTC",
        COLUMNS: "80",
        NO_COLOR: "1",
        PACK_FAKE_API_KEY: "PACK-UPSTREAM-KEY",
        LOHRA_OPENAI_API_KEY: apiKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  await waitForListening(port);

  const health = await sendRaw(port, "GET /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n");
  const unauthorized = await sendRaw(
    port,
    "GET /v1/models HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n",
  );
  const authed = await sendRaw(
    port,
    `GET /v1/models HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer ${apiKey}\nConnection: close\n`,
  );

  const chatNonStreamBody = JSON.stringify({
    model: "pack-model",
    messages: [{ role: "user", content: "hi" }],
  });
  const chatNonStream = await sendRaw(
    port,
    `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(chatNonStreamBody))}\nAuthorization: Bearer ${apiKey}\nConnection: close\n`,
    chatNonStreamBody,
  );
  const chatStreamBody = JSON.stringify({
    model: "pack-model",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  const chatStream = await sendRaw(
    port,
    `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(chatStreamBody))}\nAuthorization: Bearer ${apiKey}\nConnection: close\n`,
    chatStreamBody,
  );
  const respNonStreamBody = JSON.stringify({ model: "pack-model", input: "hi" });
  const respNonStream = await sendRaw(
    port,
    `POST /v1/responses HTTP/1.1\nHost: 127.0.0.1\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(respNonStreamBody))}\nAuthorization: Bearer ${apiKey}\nConnection: close\n`,
    respNonStreamBody,
  );
  // /v1/responses is served by the same candidate provider client as
  // /v1/chat/completions (a single --api-mode chat_completions upstream),
  // so it lands on the same fixture and the same requestCounts.chat tally.
  const respStreamBody = JSON.stringify({ model: "pack-model", input: "hi", stream: true });
  const respStream = await sendRaw(
    port,
    `POST /v1/responses HTTP/1.1\nHost: 127.0.0.1\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(respStreamBody))}\nAuthorization: Bearer ${apiKey}\nConnection: close\n`,
    respStreamBody,
  );

  success =
    health.statusLine.includes(" 200 ") &&
    health.body === '{"ok":true,"version":"0.0.11"}' &&
    unauthorized.statusLine.includes(" 401 ") &&
    authed.statusLine.includes(" 200 ") &&
    chatNonStream.statusLine.includes(" 200 ") &&
    chatNonStream.body.includes("PACK-CHAT") &&
    chatStream.statusLine.includes(" 200 ") &&
    chatStream.body.includes("PACK-STREAM") &&
    respNonStream.statusLine.includes(" 200 ") &&
    respNonStream.body.includes("PACK-CHAT") &&
    respStream.statusLine.includes(" 200 ") &&
    respStream.body.includes("PACK-STREAM");

  const evidence = {
    schemaVersion: 1,
    targetSha: checked("git", ["rev-parse", "HEAD"], { cwd: projectRoot }).stdout.trim(),
    id: "t11-pack-smoke",
    layer: "turno-publico",
    classification: "candidate-package-only",
    installedFromTarball: true,
    checkoutImports: false,
    pythonOnPath: false,
    upstreamRequestCount: requestCounts.chat,
    probes: {
      health: { statusLine: health.statusLine, body: health.body },
      unauthorized: { statusLine: unauthorized.statusLine },
      authed: { statusLine: authed.statusLine },
      chatNonStream: { statusLine: chatNonStream.statusLine },
      chatStream: { statusLine: chatStream.statusLine },
      respNonStream: { statusLine: respNonStream.statusLine },
      respStream: { statusLine: respStream.statusLine },
    },
    pass: success,
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  if (child !== undefined) child.kill("SIGKILL");
  if (upstream.listening) {
    await new Promise((resolveClose, reject) => {
      upstream.close((error) => (error ? reject(error) : resolveClose()));
      upstream.closeAllConnections();
    });
  }
  rmSync(runtimeRoot, { recursive: true, force: true });
}
process.exitCode = success ? 0 : 1;
