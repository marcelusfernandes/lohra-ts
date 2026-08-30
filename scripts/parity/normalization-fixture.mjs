#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const [mode, side] = process.argv.slice(2);
if (mode === "text") {
  process.stdout.write(side === "oracle" ? "LEFT=LEFT;RIGHT=RIGHT\n" : "LEFT=RIGHT;RIGHT=LEFT\n");
} else if (mode === "jsonl") {
  const profile = process.env.LOHRA_PARITY_PROFILE;
  if (profile === undefined) throw new Error("LOHRA_PARITY_PROFILE is required");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "events.jsonl"), `${JSON.stringify({ kind: "fixture", side })}\n`);
} else {
  throw new Error(`unknown fixture mode ${String(mode)}`);
}
