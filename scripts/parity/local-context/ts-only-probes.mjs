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
import { spawn } from "node:child_process";

import { MemoryStore } from "../../../dist/memory/index.js";
import { discoverInstructions } from "../../../dist/context/index.js";
import { pythonJsonDumps } from "../../../dist/serialization/python-json.js";

const output = resolve(".probe-evidence");
mkdirSync(output, { recursive: true });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const write = (id, observable) => {
  const projection = pythonJsonDumps(observable);
  const evidence = {
    schemaVersion: 1,
    scenario: id,
    comparisonClass: "intentional-ts-only",
    observable,
    verdict: "match",
    projectionSha256: sha(projection),
  };
  const path = join(output, `${id}.json`);
  const body = `${pythonJsonDumps(evidence)}\n`;
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (previous !== body) writeFileSync(path, body);
  process.stdout.write(`${id} ${evidence.projectionSha256}\n`);
};

const runWorker = (worker, destination, value) =>
  new Promise((resolveWorker) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", worker, destination, value],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolveWorker({ code, stderr }));
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
  const source = readFileSync(resolve("src/memory/store.ts"), "utf8");
  write("t06-memory-unique-temp", {
    firstExit: first.code,
    secondExit: second.code,
    integral: ["first", "second", "first\n§\nsecond", "second\n§\nfirst"].includes(final),
    distinctTempNames: observedTemps.size >= 2,
    residual,
    createExclusive: /openSync\(temporary, "wx", 0o666\)/u.test(source),
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
  write("t06-defensive-snapshot", {
    distinct: copy !== store.snapshot(),
    mutationRejected,
    stable: store.snapshot().memory === "stable",
  });

  const outer = join(root, "outer");
  const project = join(outer, "project");
  const cwd = join(outer, "cwd");
  mkdirSync(project, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const canary = "T06-NON-ANCESTRAL-CANARY";
  writeFileSync(join(project, "AGENTS.md"), canary, "utf8");
  let cause = "";
  let discovered = [];
  try {
    discovered = discoverInstructions(cwd, project);
  } catch (error) {
    cause = error.message;
  }
  write("t06-non-ancestral-root", {
    cause,
    canaryRead: JSON.stringify(discovered).includes(canary),
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
