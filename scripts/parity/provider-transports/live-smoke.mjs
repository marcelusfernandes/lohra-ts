#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { applyEnvFile } from "../../../dist/config/env-file.js";
import { resolvePaths } from "../../../dist/config/paths.js";
import { getProviderProfile, resolveApiKey } from "../../../dist/providers/index.js";
import { AnthropicMessagesClient, AnthropicMessagesTransport, NativeChatHttpPort } from "../../../dist/transports/index.js";

const transports = new Set(["anthropic_messages", "chat_completions", "responses"]);
const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};
const transport = valueAfter("--transport");
if (transport === null || !transports.has(transport)) {
  process.stderr.write("LIVE_TRANSPORT_INVALID\n");
  process.exitCode = 1;
} else {
  const allowed = process.argv.flatMap((value, index) =>
    value === "--allow-live" ? [process.argv[index + 1] ?? ""] : [],
  );
  const outputDirectory = resolve(".live-smoke-evidence/t10");
  const outputPath = resolve(outputDirectory, `${transport}.json`);
  const allowedKeys = [
    "schemaVersion",
    "status",
    "transport",
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
      transport,
      provider,
      model,
      success,
      exitCode,
      responseType: null,
      finishReason: null,
      shape: {
        hasOutput: false,
        completedIsBoolean: false,
        contentIsStringOrNull: false,
        toolCallsArray: false,
      },
      usage: {
        present: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      requestCount,
    };
  }

  // Precedent: T10's operator-file scrub (contract-t10) treats >=24
  // characters as the threshold for content worth treating as credential
  // material. Reused here for the same reason: below this floor, a match
  // is far more likely to be incidental (a short word, a digit run, a
  // stray newline echoed back by the provider) than a genuine secret.
  // None of what this guard is actually meant to protect — a real
  // provider API key, or the fixed 31-character smoke prompt — drops
  // below it; only content that was never a credential to begin with
  // (e.g. a short model response) stops being able to trigger a refusal.
  const MIN_SECRET_LENGTH = 24;

  const persist = (record, secrets = []) => {
    const keys = Object.keys(record);
    if (keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index])) {
      rmSync(outputPath, { force: true });
      throw new Error("LIVE_EVIDENCE_SCHEMA");
    }
    const body = `${JSON.stringify(record)}\n`;
    const matchedIndex = secrets.findIndex(
      (secret) => secret.length >= MIN_SECRET_LENGTH && body.includes(secret),
    );
    if (matchedIndex >= 0) {
      rmSync(outputPath, { force: true });
      // Index only — never the value, its length, or a prefix. The caller
      // passes secrets in a fixed, documented order, so the index alone
      // is enough to diagnose which one matched without spending another
      // real call to find out.
      process.stderr.write(`LIVE_CREDENTIAL_LEAK_SECRET_INDEX=${matchedIndex}\n`);
      throw new Error("CREDENTIAL_LEAK");
    }
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(outputPath, body, { mode: 0o600 });
  };

  function unavailable(provider = null, model = null) {
    const evidence = baseEvidence("live-smoke-unavailable", provider, model, false, 3, 0);
    persist(evidence);
    process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: outputPath })}\n`);
    process.exitCode = 3;
  }

  async function canary() {
    // Each literal is deliberately >= MIN_SECRET_LENGTH so the probe still
    // exercises the floor added for the false-positive fix, not just the
    // substring match itself.
    const key = "T10-CANARY-API-KEY-VALUE-EXACT";
    const canaryPrompt = "T10-CANARY-PROMPT-VALUE-EXACT";
    const response = "T10-CANARY-RESPONSE-VALUE-EXACT";
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
        persist(evidence, [key, canaryPrompt, response]);
      } catch (error) {
        if (error instanceof Error && error.message === "CREDENTIAL_LEAK") caught += 1;
        else throw error;
      }
    }
    if (caught !== 3 || existsSync(outputPath)) throw new Error("LIVE_SCRUB_CANARY_FAILED");
    process.stdout.write(
      `${JSON.stringify({ probe: "t10-live-scrub", transport, caught, evidenceAbsent: true })}\n`,
    );
  }

  // Recording port that refuses anything but the one allowlisted, exact
  // Anthropic Messages endpoint, and refuses a second request. Mirrors
  // chat-completions/live-smoke.mjs's AllowedRecordingPort: the caller
  // never gets network access this class won't grant, so an accidental
  // retry, redirect, or a future refactor pointing the client elsewhere
  // fails closed instead of silently calling an unreviewed endpoint.
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

  async function smokeAnthropicMessages() {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
    );
    const provider = "anthropic";
    const profile = getProviderProfile(provider);
    if (profile === null || profile.apiMode !== "anthropic_messages") {
      unavailable(provider);
      return;
    }
    const model = profile.fallbackModels[0] ?? null;
    if (model === null) {
      unavailable(provider);
      return;
    }
    // Snapshot which of this provider's credential env vars were already
    // present (e.g. a named, session-exported variable — a nominally
    // authorized source) BEFORE the operator's env file is consulted, so a
    // credential that only appears afterward can be attributed to the file
    // rather than to something the caller actually named.
    const presentBeforeEnvFile = new Set(profile.envVars.filter((name) => name in environment));
    const paths = resolvePaths(environment);
    // Whether this run's env file IS the shared store's — by resolved
    // path, not by whether LOHRA_HOME happens to be set. Checking
    // `!environment.LOHRA_HOME` alone was a bypass: pointing LOHRA_HOME at
    // the shared store itself (e.g. LOHRA_HOME=~/.lohra, the natural thing
    // to type if you mean "the store") set the variable, so the presence
    // check passed, while still reading the very file the guard exists to
    // refuse. Comparing the two resolved envFile paths closes that: it
    // catches "shared" no matter which spelling reaches it.
    const environmentWithoutLohraHome = Object.fromEntries(
      Object.entries(environment).filter(([key]) => key !== "LOHRA_HOME"),
    );
    const sharedEnvFile = resolvePaths(environmentWithoutLohraHome).envFile;
    // Resolve symlinks before comparing: a path that only LOOKS different
    // from the shared store (e.g. a symlink into it) is still the shared
    // store. Falls back to the literal path when the file doesn't exist
    // yet — nothing to resolve, and the literal comparison above already
    // covers that case correctly.
    const real = (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    const usesSharedEnvFile = real(paths.envFile) === real(sharedEnvFile);
    applyEnvFile(paths.envFile, environment);
    const apiKey = resolveApiKey(provider, environment);
    if (apiKey === null || apiKey.length === 0) {
      unavailable(provider, model);
      return;
    }
    // Refuse-with-cause: a credential that only materialized from the
    // operator's SHARED store (~/.lohra/.env — the file that resolves by
    // default, or that LOHRA_HOME points back at even when set explicitly)
    // is not a credential anyone actually named for this smoke test.
    // resolveApiKey cannot distinguish "the right key happened to be
    // there" from "an unrelated real credential happened to be there", so
    // both must be refused identically until the operator authorizes an
    // explicit, isolated source (LOHRA_HOME pointed at a DIFFERENT,
    // isolated profile file, or the env var pre-set before this process
    // starts).
    const sourcedFromSharedEnvFile =
      usesSharedEnvFile &&
      profile.envVars.some((name) => !presentBeforeEnvFile.has(name) && name in environment);
    if (sourcedFromSharedEnvFile) {
      process.stderr.write("LIVE_CREDENTIAL_SOURCE_NOT_AUTHORIZED\n");
      unavailable(provider, model);
      return;
    }
    const prompt = "Reply with the single word OK.";
    const expectedUrl = `${profile.baseUrl.replace(/\/$/u, "")}/v1/messages`;
    const port = new AllowedRecordingPort(expectedUrl);
    const transportImpl = new AnthropicMessagesTransport();
    const client = new AnthropicMessagesClient({
      baseUrl: profile.baseUrl,
      apiKey,
      transport: transportImpl,
      http: port,
      timeoutMs: 15_000,
      maxResponseBytes: 256 * 1024,
      maxRetries: 0,
    });
    try {
      const kwargs = transportImpl.buildKwargs({
        model,
        messages: [{ role: "user", content: prompt }],
        tools: [],
        maxTokens: 1,
      });
      const response = await client.create(kwargs);
      const raw = port.parsed;
      const evidence = baseEvidence("pass", provider, model, true, 0, port.requestCount);
      evidence.responseType = typeof raw?.type === "string" ? raw.type : null;
      evidence.finishReason = response.finishReason;
      evidence.shape = {
        hasOutput: Array.isArray(raw?.content) && raw.content.length > 0,
        // Anthropic's raw /v1/messages response has no boolean-typed
        // completion field (stop_reason is string|null, never boolean) —
        // legitimately always false for this transport, unlike the other
        // three shape checks, which do have real Anthropic mappings.
        completedIsBoolean: false,
        contentIsStringOrNull: typeof response.content === "string" || response.content === null,
        toolCallsArray: Array.isArray(response.toolCalls),
      };
      evidence.usage = {
        present: response.usage !== null,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        cacheReadTokens: response.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: response.usage?.cacheWriteTokens ?? 0,
        reasoningTokens: response.usage?.reasoningTokens ?? 0,
      };
      // secrets order: [0]=apiKey [1]=prompt [2]=response content
      persist(evidence, [apiKey, prompt, response.content ?? ""]);
      process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: outputPath })}\n`);
    } catch {
      const responseText = typeof port.parsed?.content?.[0]?.text === "string" ? port.parsed.content[0].text : "";
      const evidence = baseEvidence("fail", provider, model, false, 1, port.requestCount);
      // secrets order: [0]=apiKey [1]=prompt [2]=partial response text
      persist(evidence, [apiKey, prompt, responseText]);
      process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: outputPath })}\n`);
      process.exitCode = 1;
    } finally {
      await client.close();
    }
  }

  if (process.argv.includes("--canary")) {
    await canary();
  } else if (!allowed.includes(transport)) {
    // This branch intentionally precedes environment, auth, DNS, and socket access.
    unavailable();
  } else if (transport === "anthropic_messages") {
    await smokeAnthropicMessages();
  } else {
    const evidence = baseEvidence("fail", null, null, false, 1, 0);
    persist(evidence);
    process.stderr.write("LIVE_AUTHORIZATION_PRESENT_BUT_EXECUTION_NOT_CONFIGURED\n");
    process.exitCode = 1;
  }
}
