#!/usr/bin/env node
// Launches the REAL candidate scheduler mechanism as its own OS process
// (assertion 6 — never an in-process call from the harness), per decision
// 11: no `lohra dashboard` exists on this base, so the harness reaches
// `runSchedulerLoop` through this minimal dedicated launcher instead.
//
// runJob POSTs to the fake upstream (FAKE_BASE_URL) so the harness can
// count firings the same way it counts the oracle's real cron_runner ->
// run_conversation -> upstream call chain, and REJECTS on a non-2xx
// response so a failing upstream actually exercises tick()'s ok=false
// path through the real launcher, not just the unit test. diagnostics
// never touch stdout/stderr (decision 7) -- they go to
// <home>/cron/scheduler.log.
import { Buffer } from "node:buffer";
import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { CronStore } from "../../../dist/cron/store.js";
import { runSchedulerLoop } from "../../../dist/cron/scheduler.js";

// Probe 26 (assertion 44/decision 13's named example): T18_MUTANT=markrun
// patches CronStore.prototype.markRun to a no-op-that-reports-success
// before the store is ever constructed, so a restart re-fires an
// already-fired job.
if (process.env.T18_MUTANT !== undefined) {
  await import("./t18-mutant-loader.mjs");
}

const home = process.env.LOHRA_HOME;
const upstreamUrl = new URL(process.env.FAKE_BASE_URL);
const tickIntervalMs = Number(process.env.LOHRA_T18_TICK_MS ?? "500");
const logPath = join(home, "cron", "scheduler.log");
mkdirSync(join(home, "cron"), { recursive: true });

function postToUpstream(job) {
  return new Promise((resolveRequest, reject) => {
    const body = JSON.stringify({ messages: [{ role: "user", content: job.prompt }] });
    const request = http.request(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        response.on("data", () => undefined);
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400)
            reject(new Error(`upstream status ${String(response.statusCode)}`));
          else resolveRequest();
        });
      },
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

let stopped = false;
const stop = { isSet: () => stopped };
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
  });
}

const store = new CronStore(home);
await runSchedulerLoop({
  store,
  runJob: postToUpstream,
  stop,
  tickIntervalMs,
  diagnostics: (message) => {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  },
});
