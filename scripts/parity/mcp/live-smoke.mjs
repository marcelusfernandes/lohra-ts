#!/usr/bin/env node
import process from "node:process";

process.stdout.write(
  `${JSON.stringify({
    suite: "t19-live-smoke",
    status: "live-smoke-unavailable",
    reason:
      "No real MCP SDK/server or external provider authorization was supplied; fixture evidence cannot become live PASS by inference.",
  })}\n`,
);
process.exitCode = 3;
