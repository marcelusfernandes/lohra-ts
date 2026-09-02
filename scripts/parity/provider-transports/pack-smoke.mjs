#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "../../..");
const evidenceRoot = resolve(projectRoot, ".probe-evidence/t10");
const evidencePath = resolve(evidenceRoot, "t10-three-transport-pack-smoke.json");
const runtimeRoot = mkdtempSync(join(tmpdir(), "lohra-t10-pack-"));

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

function run(executable, argv, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveRun({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

const requestCounts = { anthropic: 0, chat: 0, responses: 0 };
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if ((request.url ?? "").endsWith("/messages")) {
      requestCounts.anthropic += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: [{ type: "text", text: "PACK-ANTHROPIC" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }
    if ((request.url ?? "").endsWith("/responses")) {
      requestCounts.responses += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "PACK-RESPONSES" }] } })}\n\n` +
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
      );
      return;
    }
    requestCounts.chat += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "PACK-CHAT" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        request_stream: body.stream === true,
      }),
    );
  });
});

let success;
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
  const installedTransport = join(packageRoot, "dist/transports/index.js");
  const preload = join(runtimeRoot, "redirect.mjs");

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("PACK_LISTEN_FAILED");
  const loopback = `http://127.0.0.1:${address.port}`;
  writeFileSync(
    preload,
    `import { NativeChatHttpPort } from ${JSON.stringify(pathToFileURL(installedTransport).href)};\n` +
      `const original = NativeChatHttpPort.prototype.post;\n` +
      `NativeChatHttpPort.prototype.post = function(request) {\n` +
      `  const path = new URL(request.url).pathname.endsWith('/responses') ? '/responses' : new URL(request.url).pathname.endsWith('/messages') ? '/v1/messages' : '/v1/chat/completions';\n` +
      `  return original.call(this, { ...request, url: new URL(path, process.env.LOHRA_T10_LOOPBACK).href });\n` +
      `};\n`,
  );

  const baseEnvironment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: join(runtimeRoot, "tmp"),
    TZ: "UTC",
    NO_COLOR: "1",
    COLUMNS: "80",
    LOHRA_NO_WIZARD: "1",
    LOHRA_T10_LOOPBACK: loopback,
  };
  const turn = async (name, extraEnvironment, setup = () => {}) => {
    const root = join(runtimeRoot, name);
    const home = join(root, "home");
    const profile = join(root, "profile");
    const codex = join(root, "codex");
    const cwd = join(root, "project");
    for (const directory of [home, profile, codex, cwd, baseEnvironment.TMPDIR])
      mkdirSync(directory, { recursive: true });
    setup({ home, profile, codex, cwd });
    return await run(process.execPath, ["--import", preload, bin, ...extraEnvironment.argv], {
      cwd,
      env: {
        ...baseEnvironment,
        HOME: home,
        LOHRA_HOME: profile,
        CODEX_HOME: codex,
        ...extraEnvironment.env,
      },
    });
  };

  const anthropic = await turn("anthropic", {
    argv: [
      "chat",
      "pack",
      "--json",
      "--no-tools",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4-5",
    ],
    env: { ANTHROPIC_API_KEY: "PACK-DUMMY-ANTHROPIC" },
  });
  const chat = await turn("chat", {
    argv: ["chat", "pack", "--json", "--no-tools", "--provider", "openai", "--model", "gpt-5.5"],
    env: { OPENAI_API_KEY: "PACK-DUMMY-OPENAI" },
  });
  const responses = await turn(
    "responses",
    { argv: ["chat", "pack", "--json", "--no-tools"], env: {} },
    ({ profile }) => {
      writeFileSync(
        join(profile, "auth.json"),
        JSON.stringify({
          openai: { auth_mode: "subscription", acknowledged_tos_risk: true, preference: "auto" },
        }),
      );
      writeFileSync(
        join(profile, "oauth.json"),
        JSON.stringify({
          access_token: "PACK-DUMMY-ACCESS",
          refresh_token: "PACK-DUMMY-REFRESH",
          account_id: "PACK-DUMMY-ACCOUNT",
          expires_at: 2_000_000_000,
        }),
      );
    },
  );
  const noKey = await turn("no-key", {
    argv: ["chat", "pack", "--json", "--provider", "openai", "--model", "gpt-5.5"],
    env: {},
  });
  const registry = checked(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { listProviders, getProviderProfile } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/providers/index.js")).href)}; console.log(JSON.stringify({names:listProviders().map(x=>x.name),codex:getProviderProfile('openai-codex')}));`,
    ],
    { cwd: runtimeRoot, env: baseEnvironment },
  );
  const registryValue = JSON.parse(registry.stdout);
  const turnValues = [anthropic, chat, responses].map((value) => JSON.parse(value.stdout));
  success =
    turnValues.every((value) => value.completed === true) &&
    anthropic.exitCode === 0 &&
    chat.exitCode === 0 &&
    responses.exitCode === 0 &&
    noKey.exitCode === 2 &&
    requestCounts.anthropic === 1 &&
    requestCounts.chat === 1 &&
    requestCounts.responses === 1 &&
    registryValue.names.length === 11 &&
    registryValue.codex === null;
  const evidence = {
    schemaVersion: 1,
    targetSha: checked("git", ["rev-parse", "HEAD"], { cwd: projectRoot }).stdout.trim(),
    id: "t10-three-transport-pack-smoke",
    layer: "turno-publico",
    classification: "candidate-package-only",
    installedFromTarball: true,
    checkoutImports: false,
    pythonOnPath: false,
    transports: requestCounts,
    turns: turnValues.map((value) => ({
      completed: value.completed,
      stop_reason: value.stop_reason,
    })),
    noKey: { exitCode: noKey.exitCode, requestCount: 0 },
    registry: registryValue,
    pass: success,
  };
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  if (server.listening) {
    await new Promise((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
      server.closeAllConnections();
    });
  }
  rmSync(runtimeRoot, { recursive: true, force: true });
}
process.exitCode = success ? 0 : 1;
