// `postinstall` cuida do spawn-helper em instalações de consumidores.
// `prepare` instala hooks apenas num checkout Git de desenvolvimento.
// Todos os ensaios de hooks usam repositórios temporários; worktrees reais
// compartilham hooks e nunca são alvos destes testes.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const POSTINSTALL = join(ROOT, "scripts", "postinstall.mjs");
const PREPARE = join(ROOT, "scripts", "prepare.mjs");
const PRE_PUSH_SOURCE = join(ROOT, ".claude", "hooks", "git-pre-push");
const INSTALLER_MARKER = join(ROOT, ".claude", "hooks", "instalar-git-hooks.sh");
const LEFTHOOK_PACKAGE = join(ROOT, "node_modules", "lefthook");
const LEFTHOOK_YML = join(ROOT, "lefthook.yml");

const workdirs: string[] = [];
afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function novoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "postinstall-"));
  workdirs.push(dir);
  return dir;
}

function rodarScript(script: string, cwd: string) {
  const env = { ...process.env };
  delete env.LOHRA_SKIP_PREPARE;
  return spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8", timeout: 10_000 });
}

function checkoutComHooks(): string {
  const dir = novoDir();
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  expect(init.status, init.stderr).toBe(0);
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  copyFileSync(PRE_PUSH_SOURCE, join(dir, ".claude", "hooks", "git-pre-push"));
  copyFileSync(INSTALLER_MARKER, join(dir, ".claude", "hooks", "instalar-git-hooks.sh"));
  return dir;
}

function escreverSpawnHelper(dir: string): string {
  const helper = join(
    dir,
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  mkdirSync(dirname(helper), { recursive: true });
  writeFileSync(helper, "#!/bin/sh\nexit 0\n");
  chmodSync(helper, 0o644);
  return helper;
}

describe("postinstall.mjs — spawn-helper", () => {
  it("sem spawn-helper presente, sai 0", () => {
    expect(rodarScript(POSTINSTALL, novoDir()).status).toBe(0);
  });

  it("torna spawn-helper executável em Unix mesmo sem Git", () => {
    if (process.platform === "win32") return;
    const dir = novoDir();
    const helper = escreverSpawnHelper(dir);
    expect(rodarScript(POSTINSTALL, dir).status).toBe(0);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it("não instala hooks mesmo quando .git está presente", () => {
    const dir = checkoutComHooks();
    expect(rodarScript(POSTINSTALL, dir).status).toBe(0);
    expect(existsSync(join(dir, ".git", "hooks", "pre-push"))).toBe(false);
  });
});

describe("prepare.mjs — hooks no checkout de desenvolvimento", () => {
  it("sem .git (tarball) não toca hooks e sai 0", () => {
    expect(rodarScript(PREPARE, novoDir()).status).toBe(0);
  });

  it("instala pre-push idempotente sem escrever no stdout", () => {
    const dir = checkoutComHooks();
    const first = rodarScript(PREPARE, dir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toBe("");
    const target = join(dir, ".git", "hooks", "pre-push");
    expect(readFileSync(target, "utf8")).toBe(readFileSync(PRE_PUSH_SOURCE, "utf8"));
    const second = rodarScript(PREPARE, dir);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(readFileSync(PRE_PUSH_SOURCE, "utf8"));
  });

  it.skipIf(process.platform === "win32")(
    "pre-push instalado continua recusando push para main",
    () => {
      const dir = checkoutComHooks();
      const result = rodarScript(PREPARE, dir);
      expect(result.status, result.stderr).toBe(0);
      const hook = join(dir, ".git", "hooks", "pre-push");
      const push = spawnSync("sh", [hook, "origin", "https://example.invalid/x.git"], {
        input:
          "refs/heads/x 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n",
        encoding: "utf8",
      });
      expect(push.status).toBe(1);
      expect(push.stderr).toContain("proibido");
    },
  );

  it("chama apenas lefthook install pre-commit e preserva pre-push", () => {
    const dir = checkoutComHooks();
    const marker = join(dir, "lefthook-args.json");
    const cli = join(dir, "node_modules", "lefthook", "bin", "index.js");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(
      cli,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const result = rodarScript(PREPARE, dir);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["install", "pre-commit"]);
    expect(readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8")).toBe(
      readFileSync(PRE_PUSH_SOURCE, "utf8"),
    );
  });

  it("falha do lefthook é explícita e não vira prepare 0", () => {
    const dir = checkoutComHooks();
    const cli = join(dir, "node_modules", "lefthook", "bin", "index.js");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, "process.exit(7);");
    const result = rodarScript(PREPARE, dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/lefthook.*exit 7/);
  });

  it.skipIf(!existsSync(LEFTHOOK_PACKAGE))(
    "integração real instala pre-commit sem substituir pre-push",
    () => {
      const dir = checkoutComHooks();
      copyFileSync(LEFTHOOK_YML, join(dir, "lefthook.yml"));
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      symlinkSync(
        LEFTHOOK_PACKAGE,
        join(dir, "node_modules", "lefthook"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const result = rodarScript(PREPARE, dir);
      expect(result.status, result.stderr).toBe(0);
      expect(
        readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8").toLowerCase(),
      ).toContain("lefthook");
      expect(readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8")).toBe(
        readFileSync(PRE_PUSH_SOURCE, "utf8"),
      );
    },
  );
});
