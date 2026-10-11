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
    expect(selectNativeRoute(root, common, negative)).toMatchObject({
      mode: "native-negative",
      os: "windows",
      slug,
      sources: [source, driver],
      mergeBase: common,
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
    const production = commit("production", { [source]: "// changed production" });
    expect(selectNativeRoute(root, proofOnly, production).mode).toBe("native-negative");
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
  },
  timeout,
);
