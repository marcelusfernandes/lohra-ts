#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function persistEvidence(path, evidence, secrets) {
  const keys = Object.keys(evidence);
  if (keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index])) {
    rmSync(path, { force: true });
    throw new Error("LIVE_EVIDENCE_SCHEMA");
  }
  const body = `${JSON.stringify(evidence)}\n`;
  if (secrets.some((secret) => secret.length > 0 && body.includes(secret))) {
    rmSync(path, { force: true });
    throw new Error("CREDENTIAL_LEAK");
  }
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(path, body, { mode: 0o600 });
}

async function canary() {
  const key = "T07-CANARY-KEY-EXACT";
  const canaryPrompt = "T07-CANARY-PROMPT-EXACT";
  const response = "T07-CANARY-RESPONSE-EXACT";
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

async function smoke() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
  const paths = resolvePaths(environment);
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
    persistEvidence(outputPath, evidence, [target.apiKey, prompt, responseText]);
    process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: outputPath })}\n`);
  } catch {
    const responseText =
      typeof port.parsed?.choices?.[0]?.message?.content === "string"
        ? port.parsed.choices[0].message.content
        : "";
    const evidence = baseEvidence("fail", provider, model, false, 1, port.requestCount);
    persistEvidence(outputPath, evidence, [target.apiKey, prompt, responseText]);
    process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: outputPath })}\n`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (process.argv.includes("--canary")) await canary();
else await smoke();
