import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { normalizeCloseoutOutput } from "./normalization.js";

interface InventoryRow {
  readonly id: string;
  readonly target: string;
}

interface Inventory extends Readonly<Record<string, unknown>> {
  readonly version: number;
  readonly executions: readonly InventoryRow[];
  readonly aliases: readonly (InventoryRow & { readonly coveredBy: string })[];
  readonly excluded: readonly string[];
  readonly generators: readonly string[];
  readonly helpers: readonly string[];
  readonly meta: readonly string[];
}

const project = resolve(import.meta.dirname, "../../..");
const inventoryPath = join(import.meta.dirname, "inventory.json");
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as Inventory;
const packageJson = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as {
  readonly scripts: Readonly<Record<string, string>>;
};
const evidenceDirectory = join(project, ".parity-evidence", "t22");

function allFiles(directory: string): readonly string[] {
  const output: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) output.push(relative(project, path));
    }
  };
  visit(directory);
  return output.sort();
}

function validateInventory(): { readonly entrypoints: number; readonly packageIds: number } {
  if (inventory.version !== 1) throw new Error("INVENTORY_VERSION");
  const classified = [
    ...inventory.executions.map((row) => row.id),
    ...inventory.aliases.map((row) => row.id),
    ...inventory.excluded,
    ...inventory.generators,
    ...inventory.meta,
  ];
  if (new Set(classified).size !== classified.length) throw new Error("INVENTORY_DUPLICATE_ID");
  for (const row of [...inventory.executions, ...inventory.aliases]) {
    if (packageJson.scripts[row.id] !== row.target) {
      throw new Error(`INVENTORY_TARGET:${row.id}:${packageJson.scripts[row.id] ?? "missing"}`);
    }
  }
  for (const id of [...inventory.excluded, ...inventory.generators, ...inventory.meta]) {
    if (packageJson.scripts[id] === undefined) throw new Error(`INVENTORY_MISSING:${id}`);
  }
  const packageIds = Object.keys(packageJson.scripts)
    .filter((id) => /^(?:parity|probe|smoke|mutations):|^pack:t21$/u.test(id))
    .sort();
  const unexpectedIds = packageIds.filter((id) => !classified.includes(id));
  if (unexpectedIds.length > 0)
    throw new Error(`INVENTORY_UNEXPECTED_ID:${unexpectedIds.join(",")}`);

  const entrypointPattern =
    /^(?:run-all|run-gates|run-process|run-probes|run-scheduler|run-tool|run-mutations|pack-smoke|probe|.*ts-only-probe|.*ts-only-probes|.*-probe)\.(?:ts|mjs|cjs|py)$/u;
  const entrypoints = allFiles(join(project, "scripts", "parity")).filter((path) =>
    entrypointPattern.test(path.split("/").at(-1) ?? ""),
  );
  const targets = [...inventory.executions, ...inventory.aliases]
    .map((row) => row.target)
    .join("\n");
  const unclassifiedFiles = entrypoints.filter(
    (path) => !targets.includes(path) && !inventory.helpers.includes(path),
  );
  if (unclassifiedFiles.length > 0) {
    throw new Error(`INVENTORY_UNEXPECTED_FILE:${unclassifiedFiles.join(",")}`);
  }
  return { entrypoints: entrypoints.length, packageIds: packageIds.length };
}

function runId(id: string): Promise<{ readonly id: string; readonly normalized: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("npm", ["run", id], {
      cwd: project,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        TZ: "UTC",
        LOHRA_ORACLE_WORKSPACE:
          process.env.LOHRA_ORACLE_WORKSPACE ??
          "/Users/marcelusfernandes/.traycer/worktrees/marcelusfernandes__lohra/traycer-spry-moose-d146166d9241",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLOSEOUT_TIMEOUT:${id}`));
    }, 20 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLOSEOUT_EXIT:${id}:${String(code)}:${stderr || stdout}`));
        return;
      }
      resolveRun({ id, normalized: normalizeCloseoutOutput(`${stdout}\n${stderr}`) });
    });
  });
}

const inventoryObservation = validateInventory();
if (process.argv.includes("--check-only")) {
  process.stdout.write(`${JSON.stringify({ inventory: true, ...inventoryObservation })}\n`);
  process.exit(0);
}

const runOnce = async (): Promise<readonly { readonly id: string; readonly digest: string }[]> => {
  const output: Array<{ readonly id: string; readonly digest: string }> = [];
  for (const row of inventory.executions) {
    const result = await runId(row.id);
    output.push({
      id: row.id,
      digest: createHash("sha256").update(result.normalized).digest("hex"),
    });
  }
  return output;
};

const first = await runOnce();
const second = await runOnce();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  const different = first
    .filter((row, index) => row.digest !== second[index]?.digest)
    .map((row) => row.id);
  throw new Error(`CLOSEOUT_NONDETERMINISTIC:${different.join(",")}`);
}
const observation = {
  inventory: inventoryObservation,
  executions: first,
  runs: 2,
  deterministic: true,
  missing: 0,
  unexpected: 0,
  skipped: 0,
  failures: 0,
  networkUsed: false,
  credentialsUsed: false,
};
const canonical = `${JSON.stringify(observation)}\n`;
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(join(evidenceDirectory, "closeout.json"), canonical);
process.stdout.write(
  `${JSON.stringify({ ...observation, digest: createHash("sha256").update(canonical).digest("hex") })}\n`,
);
