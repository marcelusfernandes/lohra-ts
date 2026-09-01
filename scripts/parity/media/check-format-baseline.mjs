import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const BASE = "2f212dea99dfa924a388243f8068e6dfe204590d";
const root = resolve(import.meta.dirname, "../../..");
const temporary = mkdtempSync(join(tmpdir(), "lohra-t21-format-base-"));

function run(command, args, cwd, input, binary = false) {
  return spawnSync(command, args, {
    cwd,
    encoding: binary || input !== undefined ? undefined : "utf8",
    input,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function warnings(result) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return output
    .split("\n")
    .filter((line) => line.startsWith("[warn] ") && !line.includes("Code style issues found"))
    .map((line) => line.slice(7))
    .sort();
}

function digest(values) {
  return createHash("sha256")
    .update(`${values.join("\n")}\n`)
    .digest("hex");
}

try {
  const archive = run("/usr/bin/git", ["archive", "--format=tar", BASE], root, undefined, true);
  if (archive.status !== 0 || archive.stdout === null) throw new Error("base archive failed");
  const extract = run("/usr/bin/tar", ["-xf", "-", "-C", temporary], root, archive.stdout);
  if (extract.status !== 0) throw new Error("base extract failed");
  symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"), "dir");

  const base = run("npm", ["run", "format:check"], temporary);
  const current = run("npm", ["run", "format:check"], root);
  const scoped = run(
    "npx",
    ["prettier", "--check", "src/media", "tests/media-*.test.ts", "scripts/parity/media"],
    root,
  );
  const baseWarnings = warnings(base);
  const currentWarnings = warnings(current);
  const laneWarning = currentWarnings.find(
    (path) =>
      path.startsWith("src/media/") ||
      path.startsWith("tests/media-") ||
      path.startsWith("scripts/parity/media/"),
  );
  const result = {
    suite: "t21-format-baseline",
    base: BASE,
    base_exit: base.status,
    current_exit: current.status,
    inherited_files: baseWarnings.length,
    current_files: currentWarnings.length,
    identical_warning_set: digest(baseWarnings) === digest(currentWarnings),
    warning_set_sha256: digest(baseWarnings),
    scoped_exit: scoped.status,
    lane_warning: laneWarning ?? null,
    classification: "inherited-non-blocking/T22-integration-owner",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (
    base.status === 0 ||
    current.status === 0 ||
    baseWarnings.length !== 106 ||
    result.identical_warning_set !== true ||
    scoped.status !== 0 ||
    laneWarning !== undefined
  ) {
    process.exitCode = 1;
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
