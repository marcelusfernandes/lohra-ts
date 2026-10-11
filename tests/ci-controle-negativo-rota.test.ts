import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, expect, it } from "vitest";

import { selectNativeRoute } from "../scripts/ci/controle-negativo/native-route.js";

const root = mkdtempSync(join(tmpdir(), "native-route-"));
const manifest = "scripts/ci/controle-negativo/native-routes.json";
const slug = "windows-npm-job-core";
const proof = `prova/${slug}.ts`;
const unit = "tests/npm-windows-job-core.test.ts";
const source = "scripts/subprocess/windows-helper/native/job-core.cs";
const driver = "tests/fixtures/windows-helper/job-core-driver.cs";
const route = { proof, units: [unit], sources: [source, driver] };
const timeout = 30_000;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function put(path: string, value: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function commit(message: string, changes: Record<string, string>): string {
  for (const [path, value] of Object.entries(changes)) put(path, value);
  git("add", ".");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

function declared(custom = route): Record<string, string> {
  return {
    [manifest]: JSON.stringify({ routes: { [slug]: custom } }),
    [proof]: `export default { unit: ["${unit}"] };`,
    [unit]: "// test",
    [source]: "// production",
    [driver]: "// driver",
  };
}

git("init", "-q");
git("config", "user.name", "Fixture");
git("config", "user.email", "fixture@example.invalid");
git("config", "core.autocrlf", "false");
const origin = commit("origin", { "README.md": "origin" });
let completeSha = origin;

it(
  "mede standard, negativo e positivo, inclusive slug distinto da branch",
  () => {
    const common = commit("common", { "README.md": "common" });
    expect(selectNativeRoute(root, origin, common)).toMatchObject({
      mode: "standard",
      os: "ubuntu",
      basePayload: origin,
      head: common,
      mergeBase: origin,
    });
    const negative = commit("first route", declared());
    completeSha = negative;
    expect(selectNativeRoute(root, common, negative)).toMatchObject({
      mode: "native-negative",
      os: "windows",
      slug,
      sources: [source, driver],
      mergeBase: common,
    });
    const cli = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/ci/controle-negativo/native-route.ts", root, common, negative],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      mode: "native-negative",
      basePayload: common,
      head: negative,
      mergeBase: common,
      slug,
      sources: [source, driver],
    });
    const positive = commit("driver", { [driver]: "// changed driver" });
    expect(selectNativeRoute(root, negative, positive)).toMatchObject({
      mode: "native-positive",
      os: "windows",
      slug,
      sources: [source, driver],
    });
    const proofOnly = commit("proof", {
      [proof]: `export default { unit: ["${unit}"] }; // change`,
    });
    expect(selectNativeRoute(root, positive, proofOnly).mode).toBe("native-positive");
    const unitOnly = commit("unit", { [unit]: "// changed unit" });
    expect(selectNativeRoute(root, proofOnly, unitOnly).mode).toBe("native-positive");
    const production = commit("production", { [source]: "// changed production" });
    expect(selectNativeRoute(root, unitOnly, production).mode).toBe("native-negative");
  },
  timeout,
);

it(
  "usa merge-base histórico quando a base payload avança",
  () => {
    git("checkout", "-qb", "branch", origin);
    const branch = commit("branch", { "README.md": "branch" });
    git("checkout", "-q", "-");
    const advanced = commit("main-only route", declared());
    expect(selectNativeRoute(root, advanced, branch)).toMatchObject({
      mode: "standard",
      mergeBase: origin,
      basePayload: advanced,
      head: branch,
    });
  },
  timeout,
);

it(
  "seleciona positivo para manifesto metadata com sources estáveis",
  () => {
    git("checkout", "-qb", "metadata", completeSha);
    const metadata = commit("manifest metadata", {
      [manifest]: JSON.stringify({ routes: { [slug]: { ...route, sources: [driver, source] } } }),
    });
    expect(selectNativeRoute(root, completeSha, metadata)).toMatchObject({
      mode: "native-positive",
      slug,
      sources: [source, driver],
    });
  },
  timeout,
);

it(
  "recusa remoção, C# desconhecido ou deletado e sources mudadas só no manifesto",
  () => {
    git("checkout", "-qb", "unknown", completeSha);
    const unknown = commit("rogue source", {
      "scripts/subprocess/windows-helper/native/rogue.cs": "// rogue",
    });
    expect(() => selectNativeRoute(root, completeSha, unknown)).toThrow(/UNDECLARED|UNKNOWN/);

    git("checkout", "-qb", "deleted", completeSha);
    rmSync(join(root, source));
    const deleted = commit("delete source", {
      [manifest]: JSON.stringify({ routes: { [slug]: { ...route, sources: [driver] } } }),
    });
    expect(() => selectNativeRoute(root, completeSha, deleted)).toThrow(/PATH_REMOVED/);

    git("checkout", "-qb", "manifest-only", completeSha);
    const manifestOnly = commit("remove source in manifest", {
      [manifest]: JSON.stringify({ routes: { [slug]: { ...route, sources: [driver] } } }),
    });
    expect(() => selectNativeRoute(root, completeSha, manifestOnly)).toThrow(/UNDECLARED|SOURCES/);

    git("checkout", "-qb", "removed", completeSha);
    for (const path of [proof, unit, source, driver]) rmSync(join(root, path));
    const removed = commit("remove route", { [manifest]: JSON.stringify({ routes: {} }) });
    expect(() => selectNativeRoute(root, completeSha, removed)).toThrow(/REMOVED/);
  },
  timeout,
);

it(
  "recusa duas rotas afetadas e história sem merge-base",
  () => {
    git("checkout", "-qb", "two-routes", completeSha);
    const other = {
      proof: "prova/other.ts",
      units: ["tests/other.test.ts"],
      sources: ["scripts/subprocess/windows-helper/native/other.cs"],
    };
    const two = commit("second route", {
      [manifest]: JSON.stringify({ routes: { [slug]: route, other } }),
      [other.proof]: 'export default { unit: ["tests/other.test.ts"] };',
      [other.units[0] ?? "tests/other.test.ts"]: "// other test",
      [other.sources[0] ?? "scripts/subprocess/windows-helper/native/other.cs"]: "// other",
    });
    const changed = commit("two changes", {
      [source]: "// changed",
      [other.sources[0] ?? "scripts/subprocess/windows-helper/native/other.cs"]: "// changed",
    });
    expect(() => selectNativeRoute(root, two, changed)).toThrow(/MULTIPLE/);

    git("checkout", "-qb", "left", origin);
    const left = commit("left", { "LEFT.md": "left" });
    git("checkout", "-qb", "right", origin);
    commit("right", { "RIGHT.md": "right" });
    git("checkout", "-q", "left");
    git("merge", "--no-ff", "-q", "-m", "left merge", "right");
    const leftMerge = git("rev-parse", "HEAD");
    git("checkout", "-q", "right");
    git("merge", "--no-ff", "-q", "-m", "right merge", left);
    const rightMerge = git("rev-parse", "HEAD");
    expect(git("merge-base", "--all", leftMerge, rightMerge).split("\n")).toHaveLength(2);
    expect(() => selectNativeRoute(root, leftMerge, rightMerge)).toThrow(/MERGE_BASE_AMBIGUOUS/);

    git("checkout", "--orphan", "unrelated");
    git("rm", "-rq", "--cached", ".");
    const orphan = commit("unrelated", { "UNRELATED.md": "root" });
    expect(() => selectNativeRoute(root, completeSha, orphan)).toThrow(/MERGE_BASE|GIT/);
  },
  timeout,
);

it(
  "CLI emite JSON e falha com causa para SHA inválido",
  () => {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/ci/controle-negativo/native-route.ts", root, origin, origin],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ mode: "standard", mergeBase: origin });
    expect(() => selectNativeRoute(root, "bad", origin)).toThrow(/SHA/);
    const bad = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/ci/controle-negativo/native-route.ts", root, "bad", origin],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/NATIVE_ROUTE_SHA_INVALID/);
  },
  timeout,
);
