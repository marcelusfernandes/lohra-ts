#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const directory = resolve(".live-smoke-evidence/t13");
const path = resolve(directory, "live-smoke.json");
const record = {
  schemaVersion: 1,
  status: "live-smoke-unavailable",
  provider: null,
  model: null,
  success: false,
  exitCode: 3,
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
mkdirSync(directory, { recursive: true });
writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
process.stdout.write(
  `${JSON.stringify({ status: record.status, requestCount: 0, evidence: path })}\n`,
);
process.exitCode = 3;
