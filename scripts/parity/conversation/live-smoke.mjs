#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const outputDirectory = resolve(".live-smoke-evidence/t08");
const outputPath = resolve(outputDirectory, "live-smoke.json");
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

function evidence(status = "live-smoke-unavailable") {
  return {
    schemaVersion: 1,
    status,
    provider: null,
    model: null,
    success: false,
    exitCode: status === "live-smoke-unavailable" ? 3 : 1,
    responseType: null,
    finishReason: null,
    shape: {
      hasOutput: false,
      completedIsBoolean: false,
      errorIsNullOrString: false,
      sessionShapePresent: false,
    },
    usage: {
      present: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    },
    requestCount: 0,
  };
}

function persist(value, secrets) {
  const keys = Object.keys(value);
  if (keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index]))
    throw new Error("LIVE_EVIDENCE_SCHEMA");
  const body = `${JSON.stringify(value)}\n`;
  if (secrets.some((secret) => secret.length > 0 && body.includes(secret))) {
    rmSync(outputPath, { force: true });
    throw new Error("CREDENTIAL_LEAK");
  }
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(outputPath, body, { mode: 0o600 });
}

function canary() {
  const key = "T08-LIVE-CANARY-KEY";
  const prompt = "T08-LIVE-CANARY-PROMPT";
  const response = "T08-LIVE-CANARY-RESPONSE";
  rmSync(outputPath, { force: true });
  let caught = 0;
  for (const [field, marker] of [
    ["provider", key],
    ["model", prompt],
    ["responseType", response],
  ]) {
    const value = evidence("fail");
    value[field] = marker;
    try {
      persist(value, [key, prompt, response]);
    } catch (error) {
      if (error instanceof Error && error.message === "CREDENTIAL_LEAK") caught += 1;
      else throw error;
    }
  }
  if (caught !== 3 || existsSync(outputPath)) throw new Error("LIVE_SCRUB_CANARY_FAILED");
  process.stdout.write(
    `${JSON.stringify({ probe: "t08-live-scrub", caught, evidenceAbsent: true, requestCount: 0 })}\n`,
  );
}

if (process.argv.includes("--canary")) {
  canary();
} else {
  const value = evidence();
  persist(value, []);
  process.stdout.write(`${JSON.stringify({ status: value.status, evidence: outputPath })}\n`);
  process.exitCode = 3;
}
