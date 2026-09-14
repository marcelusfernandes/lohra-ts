// Issue #535: decisão do owner registrada no issue («licença é MIT mesmo») —
// `LICENSE` dizia «All rights reserved» e `package.json#license` era
// `UNLICENSED`, o que impede uso legal do pacote (D6, milestone #19). Este
// teste pina o texto padrão da MIT License (SPDX `MIT`) e o campo
// `package.json#license`, e confere que `LICENSE` continua na whitelist de
// `files` — sem ela o tarball publicado (`npm pack`) fica sem licença.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));

interface PackageJsonForm {
  readonly license?: string;
  readonly files?: readonly string[];
}

function lerPackageJson(): PackageJsonForm {
  return JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as PackageJsonForm;
}

function lerLicense(): string {
  return readFileSync(join(RAIZ, "LICENSE"), "utf8");
}

describe("package.json#license — decisão do owner (issue #535)", () => {
  it("declara MIT", () => {
    expect(lerPackageJson().license).toBe("MIT");
  });

  it("mantém LICENSE na whitelist de files", () => {
    expect(lerPackageJson().files).toContain("LICENSE");
  });
});

describe("LICENSE — texto padrão da MIT License (issue #535)", () => {
  it("começa com o cabeçalho padrão MIT License", () => {
    expect(lerLicense().startsWith("MIT License")).toBe(true);
  });

  it("contém o copyright do owner para 2026", () => {
    expect(lerLicense()).toContain("Copyright (c) 2026 Marcelus Fernandes");
  });

  it("contém a cláusula de concessão de permissão padrão da MIT", () => {
    expect(lerLicense()).toContain("Permission is hereby granted, free of charge");
  });
});
