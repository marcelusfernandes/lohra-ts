// Issue #692: `VERSION` (src/version.ts) tem de ser a única fonte da versão
// em runtime — lida do `package.json` do pacote, nunca um literal copiado à
// mão. Dois testes: (a) igualdade com o `package.json` de verdade; (b) uma
// guarda que varre `src/**` inteiro atrás do literal da versão atual — hoje
// sete arquivos o têm, e é isso que faz este teste vermelho por asserção
// na base (não por erro estrutural).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");

function packageVersion(): string {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error('package.json has no string "version" field');
  }
  return parsed.version;
}

function listTsFiles(dir: string): readonly string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("VERSION", () => {
  it("equals the package.json version, read at runtime", async () => {
    const { VERSION } = await import("../src/version.js");
    expect(VERSION).toBe(packageVersion());
  });

  it("guard: no file under src/** hardcodes the package.json version as a literal", () => {
    const version = packageVersion();
    const srcDir = join(repoRoot, "src");
    const offenders = listTsFiles(srcDir)
      .filter((file) => file !== join(srcDir, "version.ts"))
      .filter((file) => readFileSync(file, "utf8").includes(version));
    expect(offenders).toEqual([]);
  });
});
