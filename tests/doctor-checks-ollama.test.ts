// Issue #633 (non_blocking 2 e 3 do veredito da PR #632, issue #631):
// - `providerCheck` (`src/doctor/checks.ts`) exigia `alive && models.length >
//   0` para tratar Ollama como utilizável, enquanto o Check `ollama-sem-chave`
//   só olhava `alive` -- um Ollama no ar sem nenhum modelo puxado acionava
//   `provider: fail` *e* um `warn` recomendando `lohra chat --provider
//   ollama`, comando que falharia nesse mesmo estado. `isOllamaReady` é a
//   única definição agora; os dois lados mudam juntos.
// - `docs/provedores-deteccao.md` mostrava o `detail`/`remedy` do Check em
//   duas linhas; `renderChecks` (`checks.ts:297`) emite o `detail` numa
//   única linha. O bloco da doc passa a ser a saída literal de
//   `renderChecks` para esse Check.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolvePaths } from "../src/config/paths.js";
import { isOllamaReady, renderChecks, runChecks } from "../src/doctor/checks.js";
import type { OllamaStatus } from "../src/doctor/model.js";
import { buildEnvironment } from "../src/doctor/snapshot.js";

const temporaryDirectories: string[] = [];

function environment(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "lohra-doctor-ollama-test-"));
  temporaryDirectories.push(home);
  return { HOME: home, PATH: "/usr/bin:/bin", COLUMNS: "80" };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const ollamaUrl = "http://localhost:11434/api/tags";

function ollama(models: readonly string[]): OllamaStatus {
  return { alive: true, detail: "", models, url: ollamaUrl };
}

function checksFor(models: readonly string[]) {
  const env = environment();
  const paths = resolvePaths(env);
  const snapshot = buildEnvironment(env, paths, ollama(models));
  return runChecks(snapshot);
}

describe("isOllamaReady (issue #633): única fonte de prontidão do Ollama", () => {
  it("é false sem modelos, mesmo vivo; true com pelo menos um modelo", () => {
    expect(isOllamaReady({ alive: true, detail: "", models: [], url: ollamaUrl })).toBe(false);
    expect(isOllamaReady({ alive: false, detail: "", models: ["m"], url: ollamaUrl })).toBe(false);
    expect(isOllamaReady({ alive: true, detail: "", models: ["m"], url: ollamaUrl })).toBe(true);
  });
});

describe("providerCheck e o Check ollama-sem-chave usam a mesma prontidão (issue #633, AC4)", () => {
  it("Ollama vivo sem modelos, sem chave: provider é fail, ollama-sem-chave não emite", () => {
    const checks = checksFor([]);
    const provider = checks.find((check) => check.name === "provider");
    expect(provider?.state).toBe("fail");
    expect(checks.find((check) => check.name === "ollama-sem-chave")).toBeUndefined();
  });

  it("Ollama vivo com um modelo, sem chave: provider é ok, ollama-sem-chave emite (não-regressão #631)", () => {
    const checks = checksFor(["stub-coder:1b"]);
    const provider = checks.find((check) => check.name === "provider");
    expect(provider?.state).toBe("ok");
    expect(checks.find((check) => check.name === "ollama-sem-chave")).toBeDefined();
  });
});

describe("remédio de ollama-sem-chave nunca recomenda um comando que falharia (issue #633, AC3)", () => {
  it("sem modelos: nenhum Check emite --provider ollama", () => {
    const checks = checksFor([]);
    for (const check of checks) {
      expect(check.detail).not.toContain("--provider ollama");
      expect(check.remedy).not.toContain("--provider ollama");
    }
  });

  it("com modelos: o warn ollama-sem-chave recomenda --provider ollama", () => {
    const checks = checksFor(["stub-coder:1b"]);
    const warn = checks.find((check) => check.name === "ollama-sem-chave");
    expect(warn).toBeDefined();
    expect(warn?.remedy).toContain("--provider ollama");
  });
});

describe("docs/provedores-deteccao.md espelha renderChecks (issue #633, AC5)", () => {
  it("o bloco de exemplo do Check ollama-sem-chave é a saída literal de renderChecks", () => {
    const checks = checksFor(["stub-coder:1b"]);
    const rendered = renderChecks(checks);
    const renderedLines = rendered.split("\n");
    const detailLineIndex = renderedLines.findIndex((line) => line.includes("ollama-sem-chave"));
    expect(detailLineIndex).toBeGreaterThanOrEqual(0);
    const detailLine = renderedLines[detailLineIndex] as string;
    const remedyLine = renderedLines[detailLineIndex + 1] as string;
    expect(remedyLine.includes("→")).toBe(true);
    const expectedBlock = `${detailLine}\n${remedyLine}`;

    const docPath = resolve(import.meta.dirname, "..", "docs", "provedores-deteccao.md");
    const doc = readFileSync(docPath, "utf8");
    const fenced = /## O Check `ollama-sem-chave`[\s\S]*?```\n([\s\S]*?)```/u.exec(doc);
    expect(fenced, "docs/provedores-deteccao.md perdeu o bloco de exemplo do Check").not.toBeNull();
    const docBlock = (fenced?.[1] ?? "").replace(/\n$/u, "");

    expect(docBlock).toBe(expectedBlock);
  });
});
