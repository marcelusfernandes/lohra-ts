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

describe("ci.yml — job pack-check (D3/#532)", () => {
  const yaml = readFileSync(CI, "utf8");
  const job = bloco(yaml, "pack-check");

  it("roda em ubuntu-latest e macos-latest, Node 20 e 22, sem fail-fast", () => {
    expect(job).toContain("ubuntu-latest");
    expect(job).toContain("macos-latest");
    expect(job).toMatch(/node: \["20", "22"\]/);
    expect(job).toContain("fail-fast: false");
  });

  it("faz npm ci do projeto (prime do cache de prebuilds) antes de npm run pack:check, com teto de tempo", () => {
    const ci = job.indexOf("run: npm ci");
    const pack = job.indexOf("run: npm run pack:check");
    expect(ci).toBeGreaterThan(-1);
    expect(pack).toBeGreaterThan(ci);
    expect(job).toMatch(/timeout-minutes: \d+/);
  });

  it("o job checks não tem mais bloco env (era só para o node-gyp) nem cita node-pty@1.1.0", () => {
    const checks = bloco(yaml, "checks");
    expect(checks).not.toMatch(/^ {4}env:\s*$/mu);
    expect(checks).not.toContain("node-pty@1.1.0");
  });
});
