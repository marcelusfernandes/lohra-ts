#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { applyEnvFile } from "../../../dist/config/env-file.js";
import { resolvePaths } from "../../../dist/config/paths.js";
import { getProviderProfile, resolveProviderName } from "../../../dist/providers/index.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  NativeChatHttpPort,
  resolveChatCompletionsTarget,
} from "../../../dist/transports/index.js";

const prompt = "Reply with the single word OK.";
const outputDirectory = resolve(".live-smoke-evidence");
const outputPath = resolve(outputDirectory, "t07-chat-completions.json");
const allowedKeys = [
  "schemaVersion",
  "status",
  "provider",
  "model",
  "success",
  "exitCode",
  "responseType",
  "finishReason",
  "shape",
  "usage",
  "requestCount",
];

function baseEvidence(status, provider, model, success, exitCode, requestCount) {
  return {
    schemaVersion: 1,
    status,
    provider,
    model,
    success,
    exitCode,
    responseType: null,
    finishReason: null,
    shape: {
      hasChoices: false,
      hasMessage: false,
      contentIsStringOrNull: false,
      toolCallsAbsent: false,
    },
    usage: {
      present: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    },
    requestCount,
  };
}

// Precedent: T10's operator-file scrub (contract-t10) treats >=24
// characters as the threshold for content worth treating as credential
// material. Reused here for the same reason: below this floor, a match is
// far more likely to be incidental (a short word, a digit run, a stray
// newline echoed back by the provider) than a genuine secret. None of
// what this guard is actually meant to protect — a real provider API key,
// or the fixed 31-character smoke prompt — drops below it; only content
// that was never a credential to begin with (e.g. a short model response)
// stops being able to trigger a refusal.
const MIN_SECRET_LENGTH = 24;

function persistEvidence(path, evidence, secrets) {
  const keys = Object.keys(evidence);
  if (keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index])) {
    rmSync(path, { force: true });
    throw new Error("LIVE_EVIDENCE_SCHEMA");
  }
  const body = `${JSON.stringify(evidence)}\n`;
  const matchedIndex = secrets.findIndex(
    (secret) => secret.length >= MIN_SECRET_LENGTH && body.includes(secret),
  );
  if (matchedIndex >= 0) {
    rmSync(path, { force: true });
    // Index only — never the value, its length, or a prefix. The caller
    // passes secrets in a fixed, documented order, so the index alone is
    // enough to diagnose which one matched without spending another real
    // call to find out.
    process.stderr.write(`LIVE_CREDENTIAL_LEAK_SECRET_INDEX=${matchedIndex}\n`);
    throw new Error("CREDENTIAL_LEAK");
  }
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(path, body, { mode: 0o600 });
}

async function canary() {
  // Each literal is deliberately >= MIN_SECRET_LENGTH so the probe still
  // exercises the floor added for the false-positive fix, not just the
  // substring match itself.
  const key = "T07-CANARY-API-KEY-VALUE-EXACT";
  const canaryPrompt = "T07-CANARY-PROMPT-VALUE-EXACT";
  const response = "T07-CANARY-RESPONSE-VALUE-EXACT";
  rmSync(outputPath, { force: true });
  let caught = 0;
  for (const [field, value] of [
    ["provider", key],
    ["model", canaryPrompt],
    ["responseType", response],
  ]) {
    const evidence = baseEvidence("fail", "canary", "canary", false, 1, 0);
    evidence[field] = value;
    try {
      persistEvidence(outputPath, evidence, [key, canaryPrompt, response]);
    } catch (error) {
      if (error instanceof Error && error.message === "CREDENTIAL_LEAK") caught += 1;
      else throw error;
    }
  }
  if (caught !== 3 || existsSync(outputPath)) throw new Error("LIVE_SCRUB_CANARY_FAILED");
  process.stdout.write(
    `${JSON.stringify({ probe: "t07-live-scrub", caught, evidenceAbsent: true })}\n`,
  );
}

class AllowedRecordingPort {
  requestCount = 0;
  raw = null;
  parsed = null;

  constructor(expectedUrl) {
    this.expectedUrl = expectedUrl;
    this.delegate = new NativeChatHttpPort();
  }

  async post(request) {
    if (request.url !== this.expectedUrl) throw new Error("LIVE_ENDPOINT_NOT_ALLOWLISTED");
    if (this.requestCount >= 1) throw new Error("LIVE_REQUEST_CAP");
    this.requestCount += 1;
    const response = await this.delegate.post(request);
    this.raw = new globalThis.TextDecoder().decode(response.body);
    try {
      this.parsed = JSON.parse(this.raw);
    } catch {
      this.parsed = null;
    }
    return response;
  }
}

function unavailable(provider = null, model = null) {
  const evidence = baseEvidence("live-smoke-unavailable", provider, model, false, 3, 0);
  persistEvidence(outputPath, evidence, []);
  process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: outputPath })}\n`);
  process.exitCode = 3;
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

async function smoke() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
  // Snapshot every key present in the RAW process env before the
  // operator's env file is consulted. Which provider ends up in use isn't
  // known yet (resolveProviderName decides after the merge below), so
  // this can't be scoped to one provider's env vars in advance — any key
  // that appears only after the merge came from the file, regardless of
  // which provider it turns out to belong to.
  const presentBeforeEnvFile = new Set(Object.keys(environment));
  const paths = resolvePaths(environment);
  // Whether this run's env file IS the shared store's — by resolved path,
  // not by whether LOHRA_HOME happens to be set (that was a bypass fixed
  // in provider-transports/live-smoke.mjs: pointing LOHRA_HOME at the
  // shared store itself, e.g. LOHRA_HOME=~/.lohra, sets the variable
  // without isolating anything). Comparing the two resolved envFile paths
  // — with symlinks resolved on both sides — catches "shared" no matter
  // which spelling reaches it.
  const environmentWithoutLohraHome = Object.fromEntries(
    Object.entries(environment).filter(([key]) => key !== "LOHRA_HOME"),
  );
  const sharedEnvFile = resolvePaths(environmentWithoutLohraHome).envFile;
  const usesSharedEnvFile = real(paths.envFile) === real(sharedEnvFile);
  applyEnvFile(paths.envFile, environment);
  let provider;
  try {
    provider = resolveProviderName(null, null, environment);
  } catch {
    unavailable();
    return;
  }
  if (provider === "auto") {
    unavailable();
    return;
  }
  const profile = getProviderProfile(provider);
  if (profile === null || profile.apiMode !== "chat_completions") {
    unavailable(provider);
    return;
  }
  const model = profile.fallbackModels[0] ?? null;
  if (model === null) {
    unavailable(provider);
    return;
  }
  // Refuse-with-cause: a credential that only materialized from the
  // operator's SHARED store is not a credential anyone actually
  // authorized for this smoke test. resolveApiKey (called inside
  // resolveChatCompletionsTarget below) cannot distinguish "the right key
  // happened to be there" from "an unrelated real credential happened to
  // be there", so both must be refused identically until the operator
  // authorizes an explicit, isolated source (LOHRA_HOME pointed at a
  // DIFFERENT, isolated profile file, or the env var pre-set before this
  // process starts).
  const sourcedFromSharedEnvFile =
    usesSharedEnvFile &&
    profile.envVars.some((name) => !presentBeforeEnvFile.has(name) && name in environment);
  if (sourcedFromSharedEnvFile) {
    process.stderr.write("LIVE_CREDENTIAL_SOURCE_NOT_AUTHORIZED\n");
    unavailable(provider, model);
    return;
  }
  let target;
  try {
    target = resolveChatCompletionsTarget(provider, environment);
  } catch {
    unavailable(provider, model);
    return;
  }
  const expectedUrl = `${target.profile.baseUrl.replace(/\/$/u, "")}/chat/completions`;
  const port = new AllowedRecordingPort(expectedUrl);
  const transport = new ChatCompletionsTransport();
  const client = new ChatCompletionsClient({
    baseUrl: target.profile.baseUrl,
    apiKey: target.apiKey,
    transport,
    http: port,
    timeoutMs: 15_000,
    maxResponseBytes: 256 * 1024,
    maxRetries: 0,
  });
  try {
    const kwargs = transport.buildKwargs({
      model,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      maxTokens: 1,
    });
    const response = await client.create(kwargs);
    const raw = port.parsed;
    const choices = Array.isArray(raw?.choices) ? raw.choices : [];
    const message = choices[0]?.message;
    const responseText = typeof message?.content === "string" ? message.content : "";
    const evidence = baseEvidence("pass", provider, model, true, 0, port.requestCount);
    evidence.responseType = typeof raw?.object === "string" ? raw.object : null;
    evidence.finishReason = response.finishReason;
    evidence.shape = {
      hasChoices: choices.length > 0,
      hasMessage: typeof message === "object" && message !== null,
      contentIsStringOrNull: typeof message?.content === "string" || message?.content === null,
      toolCallsAbsent: !("tool_calls" in (message ?? {})),
    };
    evidence.usage = {
      present: response.usage !== null,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      cacheReadTokens: response.usage?.cacheReadTokens ?? 0,
      reasoningTokens: response.usage?.reasoningTokens ?? 0,
    };
    // secrets order: [0]=apiKey [1]=prompt [2]=response content
    persistEvidence(outputPath, evidence, [target.apiKey, prompt, responseText]);
    process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: outputPath })}\n`);
  } catch {
    const responseText =
      typeof port.parsed?.choices?.[0]?.message?.content === "string"
        ? port.parsed.choices[0].message.content
        : "";
    const evidence = baseEvidence("fail", provider, model, false, 1, port.requestCount);
    // secrets order: [0]=apiKey [1]=prompt [2]=partial response text
    persistEvidence(outputPath, evidence, [target.apiKey, prompt, responseText]);
    process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: outputPath })}\n`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (process.argv.includes("--canary")) {
  await canary();
} else {
  const allowed = process.argv.flatMap((value, index) =>
    value === "--allow-live" ? [process.argv[index + 1] ?? ""] : [],
  );
  if (!allowed.includes("chat_completions")) {
    // This branch intentionally precedes environment, auth, DNS, and
    // socket access — mirrors provider-transports/live-smoke.mjs.
    unavailable();
  } else {
    await smoke();
  }
}
