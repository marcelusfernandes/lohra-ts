import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.env.PROBE_REPO;
if (!repo) throw new Error("PROBE_REPO_REQUIRED");

const paths = await import(pathToFileURL(join(repo, "src/config/paths.ts")).href);
const state = await import(pathToFileURL(join(repo, "src/state/connection.ts")).href);
const media = await import(pathToFileURL(join(repo, "src/media/persistence.ts")).href);
const root = mkdtempSync(join(tmpdir(), "lohra-home-minimum-"));
const explicitHome = join(root, ".lohra");
const report: Record<string, unknown> = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  sha: process.env.PROBE_SHA,
};

function name(path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

try {
  const unaligned = { HOME: root };
  const derived = paths.resolvePaths(unaligned).home;
  const path = state.stateDatabasePath(unaligned);
  const connection = state.openStateDatabase(path);
  connection.close();
  report.unaligned = {
    suppliedHome: name(explicitHome),
    resolvedHome: name(derived),
    statePath: name(path),
    existsAfterStateOpen: existsSync(derived),
    suppliedHomeExists: existsSync(explicitHome),
  };
  try {
    lstatSync(explicitHome);
    (report.unaligned as Record<string, unknown>).lstat = "PASS";
  } catch (error) {
    (report.unaligned as Record<string, unknown>).lstat = {
      code: (error as NodeJS.ErrnoException).code,
      syscall: (error as NodeJS.ErrnoException).syscall,
    };
  }
  try {
    media.createOutputPlan(join(explicitHome, "images"));
    (report.unaligned as Record<string, unknown>).media = "PASS";
  } catch (error) {
    (report.unaligned as Record<string, unknown>).media = {
      code: (error as NodeJS.ErrnoException).code,
      syscall: (error as NodeJS.ErrnoException).syscall,
    };
  }

  const aligned = { HOME: root, LOHRA_HOME: explicitHome };
  const alignedPath = state.stateDatabasePath(aligned);
  const alignedConnection = state.openStateDatabase(alignedPath);
  alignedConnection.close();
  const plan = media.createOutputPlan(join(explicitHome, "images"));
  report.aligned = {
    resolvedHome: name(paths.resolvePaths(aligned).home),
    statePath: name(alignedPath),
    suppliedHomeExists: existsSync(explicitHome),
    lstat: lstatSync(explicitHome).isDirectory() ? "PASS" : "NOT_DIRECTORY",
    media: name(plan.outDir),
  };
  console.log(JSON.stringify(report));
} finally {
  rmSync(root, { recursive: true, force: true });
}
