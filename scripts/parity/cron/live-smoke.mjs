#!/usr/bin/env node
// Assertion 4: without `--allow-live cron` explicitly authorized by the
// Planner/user, this runner makes ZERO DNS/connect/credential-read calls,
// writes a closed schema with status:"live-smoke-unavailable",
// success:false, exitCode:3, requestCount:0, and exits 3. This branch runs
// BEFORE any environment, auth, DNS, or socket access — never inferred
// PASS. Mirrors T11's live-smoke.mjs exactly.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const allowed = process.argv.flatMap((value, index) =>
  value === "--allow-live" ? [process.argv[index + 1] ?? ""] : [],
);

const outputDirectory = resolve(".live-smoke-evidence/t18");
const outputPath = resolve(outputDirectory, "cron.json");

const unavailable = {
  schemaVersion: 1,
  status: "live-smoke-unavailable",
  transport: "cron",
  provider: null,
  model: null,
  success: false,
  exitCode: 3,
  requestCount: 0,
};

const allowedKeys = ["schemaVersion", "status", "transport", "provider", "model", "success", "exitCode", "requestCount"];

function persist(record) {
  if (JSON.stringify(Object.keys(record)) !== JSON.stringify(allowedKeys)) throw new Error("LIVE_EVIDENCE_SCHEMA");
  rmSync(outputPath, { force: true });
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// This branch intentionally precedes environment, auth, DNS, and socket
// access -- a live cron-scheduled run against a real provider stays a
// visible shortfall, never PASS by inference.
if (!allowed.includes("cron")) {
  persist(unavailable);
  process.stdout.write(`${JSON.stringify({ status: unavailable.status, evidence: outputPath })}\n`);
  process.exitCode = 3;
} else {
  const failed = { ...unavailable, status: "fail", exitCode: 1 };
  persist(failed);
  process.stderr.write("LIVE_AUTHORIZATION_PRESENT_BUT_EXECUTION_NOT_CONFIGURED\n");
  process.exitCode = 1;
}
