#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

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
  const unavailable = {
    schemaVersion: 1,
    status: "live-smoke-unavailable",
    transport,
    provider: null,
    model: null,
    success: false,
    exitCode: 3,
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
    requestCount: 0,
  };
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
  const persist = (record) => {
    if (JSON.stringify(Object.keys(record)) !== JSON.stringify(allowedKeys))
      throw new Error("LIVE_EVIDENCE_SCHEMA");
    rmSync(outputPath, { force: true });
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };

  // This branch intentionally precedes environment, auth, DNS, and socket access.
  if (!allowed.includes(transport)) {
    persist(unavailable);
    process.stdout.write(
      `${JSON.stringify({ status: unavailable.status, evidence: outputPath })}\n`,
    );
    process.exitCode = 3;
  } else {
    const failed = { ...unavailable, status: "fail", exitCode: 1 };
    persist(failed);
    process.stderr.write("LIVE_AUTHORIZATION_PRESENT_BUT_EXECUTION_NOT_CONFIGURED\n");
    process.exitCode = 1;
  }
}
