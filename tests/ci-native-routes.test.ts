import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { validateNativeRoutes } from "../scripts/ci/controle-negativo/native-routes.js";

const manifest = "scripts/ci/controle-negativo/native-routes.json";
const proof = "prova/windows-npm-job-core.ts";
const unit = "tests/npm-windows-job-core.test.ts";
const source = "scripts/subprocess/windows-helper/native/job-core.cs";
const driver = "tests/fixtures/windows-helper/job-core-driver.cs";
const route = { proof, units: [unit], sources: [source, driver] };
const directories: string[] = [];
// Cada caso cria commits e chama Git várias vezes; no Windows montado em F: sob carga,
// dois casos passaram de 5 s (default Vitest). Os subprocessos têm limites próprios.
const GIT_FIXTURE_TIMEOUT_MS = 30_000;

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function put(root: string, path: string, text: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text);
}

function fixture(files: Record<string, string> = {}): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "native-routes-"));
  directories.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  put(root, "README.md", "fixture\n");
  for (const [path, text] of Object.entries(files)) put(root, path, text);
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return { root, sha: git(root, "rev-parse", "HEAD") };
}

function complete(extra: Record<string, string> = {}): { root: string; sha: string } {
  return fixture({
    [manifest]: JSON.stringify({ routes: { "windows-npm-job-core": route } }),
    [proof]: `export default { unit: ["${unit}"] };`,
    [unit]: "// unit",
    [source]: "// source",
    [driver]: "// driver",
    ...extra,
  });
}

it(
  "lê manifesto vazio e rota core da árvore Git exata",
  () => {
    const empty = fixture({ [manifest]: JSON.stringify({ routes: {} }) });
    expect(validateNativeRoutes(empty.root, empty.sha)).toEqual({});
    const filled = complete();
    put(filled.root, proof, `export default { unit: ["tests/other.test.ts"] };`);
    expect(validateNativeRoutes(filled.root, filled.sha)).toEqual({
      "windows-npm-job-core": route,
    });
  },
  GIT_FIXTURE_TIMEOUT_MS,
);

it(
  "aceita árvore histórica vazia e recusa C# gerenciado sem manifesto",
  () => {
    const old = fixture();
    expect(validateNativeRoutes(old.root, old.sha)).toEqual({});
    const orphan = fixture({ [driver]: "// driver" });
    expect(() => validateNativeRoutes(orphan.root, orphan.sha)).toThrow(/MANIFEST/);
  },
  GIT_FIXTURE_TIMEOUT_MS,
);

it(
  "recusa C# omitido sob ambas as raízes gerenciadas",
  () => {
    for (const path of [source, driver]) {
      const { root, sha } = complete({
        [manifest]: JSON.stringify({
          routes: {
            "windows-npm-job-core": { ...route, sources: [path === source ? driver : source] },
          },
        }),
      });
      expect(() => validateNativeRoutes(root, sha)).toThrow(/UNDECLARED.*\.cs/);
    }
  },
  GIT_FIXTURE_TIMEOUT_MS,
);

it(
  "recusa fontes ausentes, duplicadas e fora das raízes",
  () => {
    for (const sources of [
      [source, driver, "tests/fixtures/windows-helper/missing.cs"],
      [source, source, driver],
      [source, driver, "other.cs"],
    ]) {
      const { root, sha } = complete({
        [manifest]: JSON.stringify({ routes: { "windows-npm-job-core": { ...route, sources } } }),
      });
      expect(() => validateNativeRoutes(root, sha)).toThrow();
    }
  },
  GIT_FIXTURE_TIMEOUT_MS,
);

it(
  "recusa traversal, path absoluto e duplicata entre rotas",
  () => {
    for (const bad of [
      "../tests/fixtures/windows-helper/job-core-driver.cs",
      "/tests/fixtures/windows-helper/job-core-driver.cs",
    ]) {
      const { root, sha } = complete({
        [manifest]: JSON.stringify({
          routes: { "windows-npm-job-core": { ...route, sources: [source, driver, bad] } },
        }),
      });
      expect(() => validateNativeRoutes(root, sha)).toThrow(/PATH/);
    }
    const { root, sha } = complete({
      [manifest]: JSON.stringify({
        routes: {
          "windows-npm-job-core": route,
          other: { proof: "prova/other.ts", units: ["tests/other.test.ts"], sources: [source] },
        },
      }),
      "prova/other.ts": 'export default { unit: ["tests/other.test.ts"] };',
      "tests/other.test.ts": "// other",
    });
    expect(() => validateNativeRoutes(root, sha)).toThrow(/DUPLICATE/);
  },
  GIT_FIXTURE_TIMEOUT_MS,
);

it(
  "recusa symlink Git mesmo quando o destino existe",
  () => {
    const repo = complete();
    const link = "tests/fixtures/windows-helper/linked.cs";
    put(repo.root, ".link-target", "job-core-driver.cs");
    const blob = git(repo.root, "hash-object", "-w", ".link-target");
    git(repo.root, "update-index", "--add", "--cacheinfo", `120000,${blob},${link}`);
    put(
      repo.root,
      manifest,
      JSON.stringify({
        routes: { "windows-npm-job-core": { ...route, sources: [...route.sources, link] } },
      }),
    );
    git(repo.root, "add", manifest);
    git(repo.root, "commit", "-qm", "link");
    expect(() => validateNativeRoutes(repo.root, git(repo.root, "rev-parse", "HEAD"))).toThrow(
      /REGULAR/,
    );
  },
  GIT_FIXTURE_TIMEOUT_MS,
);

it(
  "importa validador e parser reutilizado sem executar CLI ou prova",
  () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'await import("./scripts/ci/controle-negativo/native-routes.ts"); await import("./scripts/ci/controle-negativo/native.ts");',
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  },
  GIT_FIXTURE_TIMEOUT_MS,
);

it(
  "iguala units à declaração literal da prova e recusa prova dinâmica ou inválida",
  () => {
    for (const text of [
      `export default { unit: ["${unit}", "tests/extra.test.ts"] };`,
      `export default { unit: [] };`,
      "const units = ['tests/npm-windows-job-core.test.ts']; export default { unit: units };",
      "export const unit = ['tests/npm-windows-job-core.test.ts'];",
      `export default { unit: ["${unit}"] ;`,
      `export default { unit: ["${unit}"] }; const = ;`,
    ]) {
      const { root, sha } = complete({ [proof]: text });
      expect(() => validateNativeRoutes(root, sha)).toThrow(/PROOF|UNITS/);
    }
  },
  GIT_FIXTURE_TIMEOUT_MS,
);

it(
  "recusa manifesto, proof e unit pendurados ou não regulares",
  () => {
    for (const path of [proof, unit]) {
      const files = {
        [manifest]: JSON.stringify({ routes: { "windows-npm-job-core": route } }),
        [source]: "// source",
        [driver]: "// driver",
        [proof]: `export default { unit: ["${unit}"] };`,
        [unit]: "// unit",
      };
      const { root, sha } = fixture(
        Object.fromEntries(Object.entries(files).filter(([key]) => key !== path)),
      );
      expect(() => validateNativeRoutes(root, sha)).toThrow(/MISSING/);
    }
    const { root, sha } = fixture({ [manifest]: "{" });
    expect(() => validateNativeRoutes(root, sha)).toThrow(/MANIFEST/);
  },
  GIT_FIXTURE_TIMEOUT_MS,
);
