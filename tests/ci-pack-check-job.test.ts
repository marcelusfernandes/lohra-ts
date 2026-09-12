// Job `pack-check` em `.github/workflows/ci.yml` (D3/#532, épico #529): prova que
// o tarball instala num consumidor limpo SEM compilar nativo, em Linux e macOS,
// Node 20 e 22. Pina a forma do job — não é required no ruleset (gate humano).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CI = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

function bloco(yaml: string, job: string): string {
  // Job ausente → bloco vazio: as asserções abaixo falham por conteúdo (o
  // controle negativo classifica como vermelho de asserção, não estrutural).
  const inicio = yaml.indexOf(`\n  ${job}:\n`);
  if (inicio === -1) return "";
  const resto = yaml.slice(inicio + 1);
  const proximo = resto.slice(1).search(/\n {2}[a-z-]+:\n/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

const MUTATIONS = fileURLToPath(new URL("../.github/workflows/mutations.yml", import.meta.url));

describe("mutations.yml — job mutate sem env do node-gyp (#562)", () => {
  it("o job mutate não tem bloco env: nada compila via node-gyp desde D10 (#549)", () => {
    const mutate = bloco(readFileSync(MUTATIONS, "utf8"), "mutate");
    expect(mutate).not.toBe("");
    expect(mutate).not.toMatch(/^ {4}env:\s*$/mu);
  });
});

describe("ci.yml — job pack-check (D3/#532)", () => {
  const yaml = readFileSync(CI, "utf8");
  const job = bloco(yaml, "pack-check");

  it("roda em ubuntu-latest e macos-latest, Node 20 e 22, sem fail-fast", () => {
    expect(job).toContain("ubuntu-latest");
    expect(job).toContain("macos-latest");
    expect(job).toMatch(/node: \["20", "22"\]/);
    expect(job).toContain("fail-fast: false");
  });

  it("faz npm ci → npm run build → npm run pack:check nessa ordem, com teto de tempo", () => {
    // `npm pack` roda com LOHRA_SKIP_PREPARE=1 (scripts/pack-check.ts), então o
    // step `build` é o único produtor de `dist/` no tarball — sem ele o job
    // quebra em silêncio (veredito da PR #560, issue #562).
    const ci = job.indexOf("run: npm ci");
    const build = job.indexOf("run: npm run build");
    const pack = job.indexOf("run: npm run pack:check");
    expect(ci).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(ci);
    expect(pack).toBeGreaterThan(build);
    expect(job).toMatch(/timeout-minutes: \d+/);
  });

  it("o comentário do job cita os dois caches que o consumidor offline precisa", () => {
    expect(job).toContain("_prebuilds");
    expect(job).toContain("_cacache");
  });

  it("o job checks não tem mais bloco env (era só para o node-gyp) nem cita node-pty@1.1.0", () => {
    const checks = bloco(yaml, "checks");
    expect(checks).not.toMatch(/^ {4}env:\s*$/mu);
    expect(checks).not.toContain("node-pty@1.1.0");
  });
});
