#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";

import { MemoryStore } from "../../../dist/memory/index.js";
import { discoverInstructions } from "../../../dist/context/index.js";
import { pythonJsonDumps } from "../../../dist/serialization/python-json.js";

const output = resolve(".probe-evidence");
mkdirSync(output, { recursive: true });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const write = (id, observable, expected) => {
  const projection = pythonJsonDumps(observable);
  const failures = isDeepStrictEqual(observable, expected)
    ? []
    : [{ field: "observable", expected, actual: observable }];
  const evidence = {
    schemaVersion: 1,
    scenario: id,
    comparisonClass: "intentional-ts-only",
    observable,
    expected,
    failures,
    verdict: failures.length === 0 ? "match" : "divergent",
    projectionSha256: sha(projection),
  };
  const path = join(output, `${id}.json`);
  const body = `${pythonJsonDumps(evidence)}\n`;
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (previous !== body) writeFileSync(path, body);
  process.stdout.write(`${id} ${evidence.verdict} ${evidence.projectionSha256}\n`);
  if (failures.length > 0) process.exitCode = 1;
};

const runWorker = (worker, destination, value, execArgs = []) =>
  new Promise((resolveWorker) => {
    const child = spawn(
      process.execPath,
      [...execArgs, "--input-type=module", "-e", worker, destination, value],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolveWorker({ code, stdout, stderr }));
  });

const root = mkdtempSync(join(tmpdir(), "lohra-t06-probes-"));
try {
  const memoryHome = join(root, "concurrent");
  const worker = `import { MemoryFile } from ${JSON.stringify(new URL("../../../dist/memory/index.js", import.meta.url).href)}; const file = new MemoryFile(process.argv[1],2200); for (let index=0; index<200; index++) file.add(process.argv[2]);`;
  const destination = join(memoryHome, "memories", "MEMORY.md");
  mkdirSync(join(memoryHome, "memories"), { recursive: true });
  const observedTemps = new Set();
  const watcher = watch(join(memoryHome, "memories"), (_event, filename) => {
    if (filename?.endsWith(".tmp")) observedTemps.add(filename);
  });
  const [first, second] = await Promise.all([
    runWorker(worker, destination, "first"),
    runWorker(worker, destination, "second"),
  ]);
  watcher.close();
  const residual = readdirSync(join(memoryHome, "memories")).filter((name) =>
    name.endsWith(".tmp"),
  );
  const final = readFileSync(destination, "utf8");
  const fixedUuid = "00000000-0000-4000-8000-000000000000";
  const preload = join(root, "fixed-random-uuid.cjs");
  writeFileSync(
    preload,
    `const crypto = require("node:crypto"); const { syncBuiltinESMExports } = require("node:module"); crypto.randomUUID = () => ${JSON.stringify(fixedUuid)}; syncBuiltinESMExports();\n`,
  );
  const collisionWorker = `import { existsSync, writeFileSync } from "node:fs"; import { basename, dirname, join } from "node:path"; import process from "node:process"; import { MemoryFile } from ${JSON.stringify(new URL("../../../dist/memory/index.js", import.meta.url).href)}; const destination = process.argv[1]; const temporary = join(dirname(destination), \`.\${basename(destination)}.\${String(process.pid)}.${fixedUuid}.tmp\`); writeFileSync(temporary, "sentinel", { flag: "wx", mode: 0o666 }); let code = ""; try { new MemoryFile(destination, 2200).add("collision"); } catch (error) { code = error?.code ?? ""; } process.stdout.write(JSON.stringify({ rejected: code === "EEXIST", destinationAbsent: !existsSync(destination) }));`;
  const collisionDestination = join(memoryHome, "memories", "COLLISION.md");
  const collision = await runWorker(collisionWorker, collisionDestination, "unused", [
    "--require",
    preload,
  ]);
  const collisionObservable =
    collision.code === 0
      ? JSON.parse(collision.stdout)
      : { rejected: false, destinationAbsent: false };
  const uniqueObservable = {
    firstExit: first.code,
    secondExit: second.code,
    integral: ["first", "second", "first\n§\nsecond", "second\n§\nfirst"].includes(final),
    distinctTempNames: observedTemps.size >= 2,
    residual,
    createExclusive: collisionObservable.rejected && collisionObservable.destinationAbsent,
  };
  write("t06-memory-unique-temp", uniqueObservable, {
    firstExit: 0,
    secondExit: 0,
    integral: true,
    distinctTempNames: true,
    residual: [],
    createExclusive: true,
  });

  const defensiveHome = join(root, "defensive");
  const store = new MemoryStore(defensiveHome);
  store.memory.add("stable");
  store.loadSnapshot();
  const copy = store.snapshot();
  let mutationRejected = false;
  try {
    copy.memory = "mutated";
  } catch {
    mutationRejected = true;
  }
  const defensiveObservable = {
    distinct: copy !== store.snapshot(),
    mutationRejected,
    stable: store.snapshot().memory === "stable",
  };
  write("t06-defensive-snapshot", defensiveObservable, {
    distinct: true,
    mutationRejected: true,
    stable: true,
  });

  const outer = join(root, "outer");
  const project = join(outer, "project");
  const cwd = join(outer, "cwd");
  mkdirSync(project, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const canary = "T06-NON-ANCESTRAL-CANARY";
  writeFileSync(join(outer, "AGENTS.md"), canary, "utf8");
  let cause = "";
  let discovered = [];
  try {
    discovered = discoverInstructions(cwd, project);
  } catch (error) {
    cause = error.message;
  }
  const pathSafetyObservable = {
    cause,
    canaryRead: JSON.stringify(discovered).includes(canary),
  };
  write("t06-non-ancestral-root", pathSafetyObservable, {
    cause: "PROJECT_ROOT_NOT_ANCESTOR",
    canaryRead: false,
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
