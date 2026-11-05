// Issue #692: `VERSION` (src/version.ts) tem de ser a única fonte da versão
// em runtime — lida do `package.json` do pacote, nunca um literal copiado à
// mão. Três testes: (a) igualdade com o `package.json` de verdade; (b) uma
// guarda que varre `src/**` atrás do literal da versão atual (a única linha
// ignorada é o `info.version` do OpenAPI do gateway, preso em `"0.1.0"` por
// `tests/gateway/http-routes.test.ts` como documento do gateway, não como
// versão do pacote); (c) fail-closed quando o `version` do `package.json`
// não é string.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// `src/gateway/http/routes.ts` pins OpenAPI `info.version` at `"0.1.0"`.
// `tests/gateway/http-routes.test.ts` says that string is the gateway
// document, not the package version. A package version of `0.1.0` collides
// with a raw substring scan. Drop that one line before searching. A second
// occurrence in the same file, or the same text in any other file, still
// fails. A later package version copied onto that line is not this text, so
// the guard catches it.
const PINNED_GATEWAY_DOC_VERSION = 'version: "0.1.0",';

function sourceHardcodesPackageVersion(file: string, source: string, version: string): boolean {
  const routes = join("src", "gateway", "http", "routes.ts");
  const scanned = file.endsWith(routes) ? source.replace(PINNED_GATEWAY_DOC_VERSION, "") : source;
  return scanned.includes(version);
}

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
    const offenders = listTsFiles(srcDir).filter((file) =>
      sourceHardcodesPackageVersion(file, readFileSync(file, "utf8"), version),
    );
    expect(offenders).toEqual([]);
  });

  it("ignores only the pinned gateway OpenAPI document version, not a second copy", () => {
    const routes = join("src", "gateway", "http", "routes.ts");
    const pinned = '    version: "0.1.0",\n';
    expect(sourceHardcodesPackageVersion(routes, pinned, "0.1.0")).toBe(false);
    expect(
      sourceHardcodesPackageVersion(routes, `${pinned}const other = "0.1.0";\n`, "0.1.0"),
    ).toBe(true);
    expect(sourceHardcodesPackageVersion(join("src", "version.ts"), pinned, "0.1.0")).toBe(true);
    expect(sourceHardcodesPackageVersion(routes, '    version: "0.1.1",\n', "0.1.1")).toBe(true);
  });

  it("readPackageVersion is fail-closed when package.json has no string version", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-version-"));
    roots.push(root);
    const packageDir = join(root, "dist");
    mkdirSync(packageDir, { recursive: true });
    const packageJsonPath = join(root, "package.json");
    const fakeModuleUrl = pathToFileURL(join(packageDir, "version.js")).href;
    writeFileSync(packageJsonPath, JSON.stringify({ version: 42 }), "utf8");
    const { readPackageVersion } = await import("../src/version.js");
    expect(() => readPackageVersion(fakeModuleUrl)).toThrow(/no string "version" field/);
  });
});
