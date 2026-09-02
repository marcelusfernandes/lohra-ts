#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../../dist/cli.js");
const [mode = "single", mutant = ""] = (process.argv[2] ?? "single").split("@");
const argv = process.argv.slice(3);

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function write(result, stdout = result.stdout, stderr = result.stderr) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return result.status ?? 1;
}

if (mode === "resume" || mode === "resume-rerender") {
  const divider = argv.indexOf("--next-input");
  if (divider < 0) throw new Error("RESUME_INPUT_MISSING");
  const firstArgs = argv.slice(0, divider);
  const nextInput = argv[divider + 1];
  if (nextInput === undefined) throw new Error("RESUME_INPUT_MISSING");
  const first = run(firstArgs);
  if (first.status !== 0) process.exitCode = write(first);
  else {
    if (mode === "resume-rerender") {
      const profileIndex = firstArgs.indexOf("--profile");
      const profile = profileIndex < 0 ? "" : (firstArgs[profileIndex + 1] ?? "");
      const home = resolve(process.env.HOME ?? "", ".lohra", "profiles", profile, "memories");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(home, { recursive: true });
      writeFileSync(resolve(home, "MEMORY.md"), "CANARY-TURN-TWO", "utf8");
    }
    const id = JSON.parse(first.stdout).session_id;
    const second = run([
      ...firstArgs.slice(0, 1),
      nextInput,
      ...firstArgs.slice(2),
      "--session",
      id,
    ]);
    let stdout = second.stdout;
    if (mutant === "resume-cumulative" && second.status === 0) {
      const parsed = JSON.parse(stdout);
      parsed.usage = { input_tokens: 22, output_tokens: 14 };
      parsed.usage_total = { input_tokens: 22, output_tokens: 14 };
      stdout = `${JSON.stringify(parsed, null, 2)}\n`;
    }
    process.exitCode = write(second, stdout, `${first.stderr}${second.stderr}`);
  }
} else {
  const result = run(argv);
  let stdout = result.stdout;
  if (stdout && mutant === "json-stringify") {
    stdout = `${JSON.stringify(JSON.parse(stdout), null, 2)}\n`;
  } else if (stdout && mutant === "session-on-error") {
    const parsed = JSON.parse(stdout);
    parsed.session = null;
    stdout = `${JSON.stringify(parsed, null, 2)}\n`;
  } else if (stdout && mutant === "usage-zero-fields") {
    const parsed = JSON.parse(stdout);
    for (const key of ["usage", "usage_total"]) {
      if (parsed[key])
        Object.assign(parsed[key], {
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
        });
    }
    stdout = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  const dbPath = resolve(process.env.LOHRA_HOME ?? "", "state.db");
  if (result.status === 0 && mutant === "prompt-not-stored") {
    const db = new Database(dbPath);
    db.prepare("UPDATE sessions SET system_prompt = 'MUTATED'").run();
    db.close();
  }
  if (result.status !== 0 && mutant === "error-persists-message") {
    const db = new Database(dbPath);
    const id = db.prepare("SELECT id FROM sessions LIMIT 1").pluck().get();
    db.prepare("UPDATE sessions SET id = 'mutant-session', message_count = 1 WHERE id = ?").run(id);
    db.prepare(
      "INSERT INTO messages(session_id, role, content, timestamp, active) VALUES ('mutant-session', 'user', 'MUTATED', 0, 1)",
    ).run();
    db.close();
  }
  process.exitCode = write(result, stdout);
}
