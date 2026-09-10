// Issue #156 (13-S9): `.github/workflows/mutations.yml` roda mutação por fatia
// numa PR, filtrada por path. A seleção de fatias é de
// `scripts/github/mutations-matrix.ts`: lê `scripts/mutations/slices.json` e o
// diff `base...head`, e emite a matriz. Fail-closed: glob fora da forma
// `src/<dir>/**` OU `src/<arquivo>.ts` (arquivo de topo, issue #195: fecha o
// buraco de `src/cli.ts`, que nenhum `src/<dir>/**` cobre) lança; mudança em
// `scripts/mutations/**` seleciona todas.
// O YAML é pinado por leitura textual (mesmo idioma de ci-workflow-order):
// sem parser de YAML nas dependências.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readSlices, selectSlices, type SliceEntry } from "../scripts/github/mutations-matrix.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = resolve(ROOT, ".github/workflows/mutations.yml");
const SLICES = resolve(ROOT, "scripts/mutations/slices.json");
const SCRIPT = resolve(ROOT, "scripts/github/mutations-matrix.ts");

const FIXTURE: readonly SliceEntry[] = [
  { slice: "alfa", script: "mutations:alfa", srcGlobs: ["src/a/**"] },
  { slice: "beta", script: "mutations:beta", srcGlobs: ["src/a/**", "src/b/**"] },
  { slice: "gama", script: "mutations:gama", srcGlobs: ["src/c/**"] },
];

function slicesOf(files: readonly string[], slices: readonly SliceEntry[] = FIXTURE): string[] {
  return selectSlices(slices, files).include.map((entry) => entry.slice);
}

describe("mutations-matrix — seleção de fatias", () => {
  it("diff só de docs não seleciona nenhuma fatia", () => {
    const matrix = selectSlices(FIXTURE, ["docs/x.md", "README.md"]);
    expect(matrix.count).toBe(0);
    expect(matrix.include).toEqual([]);
  });

  it("arquivo sob src/<dir>/ seleciona exatamente as fatias cujo srcGlobs casa", () => {
    expect(slicesOf(["src/a/x.ts"])).toEqual(["alfa", "beta"]);
    expect(slicesOf(["src/b/y.ts"])).toEqual(["beta"]);
    expect(slicesOf(["src/c/z/w.ts", "docs/n.md"])).toEqual(["gama"]);
  });

  it("arquivo de topo em src/ não casa src/<dir>/** (sem fatia)", () => {
    expect(slicesOf(["src/cli.ts"])).toEqual([]);
  });

  it("mudança em scripts/mutations/** seleciona todas as fatias", () => {
    const matrix = selectSlices(FIXTURE, ["scripts/mutations/harness.ts"]);
    expect(matrix.include.map((entry) => entry.slice)).toEqual(["alfa", "beta", "gama"]);
    expect(matrix.reason).toBe("harness");
  });

  it("cada entrada da matriz leva o script npm da fatia", () => {
    expect(selectSlices(FIXTURE, ["src/c/z.ts"]).include).toEqual([
      { slice: "gama", script: "mutations:gama" },
    ]);
  });

  it("glob fora da forma src/<dir>/** lança (fail-closed)", () => {
    const ruim: readonly SliceEntry[] = [{ slice: "x", script: "s", srcGlobs: ["src/**"] }];
    expect(() => selectSlices(ruim, ["src/a.ts"])).toThrow(/src\/<dir>\/\*\*/);
  });

  it("aceita a forma literal src/<arquivo>.ts (arquivo de topo) e casa só esse arquivo (issue #195, pino 1)", () => {
    const comArquivoDeTopo: readonly SliceEntry[] = [
      { slice: "alfa", script: "mutations:alfa", srcGlobs: ["src/a/**", "src/cli.ts"] },
      { slice: "beta", script: "mutations:beta", srcGlobs: ["src/b/**"] },
    ];
    expect(slicesOf(["src/cli.ts"], comArquivoDeTopo)).toEqual(["alfa"]);
    expect(slicesOf(["src/cli/arg-spec.ts"], comArquivoDeTopo)).toEqual([]);
    expect(slicesOf(["src/a/x.ts"], comArquivoDeTopo)).toEqual(["alfa"]);
  });

  it("contra o slices.json real: src/workflow/service.ts dispara as três fatias de workflow e nenhuma outra", () => {
    const real = readSlices(SLICES);
    expect(slicesOf(["src/workflow/service.ts"], real)).toEqual([
      "workflow-executor",
      "workflow-durability",
      "workflow-audit-live",
    ]);
    expect(slicesOf(["docs/adr/0003.md"], real)).toEqual([]);
  });

  it("contra o slices.json real: src/cli.ts (arquivo de topo) seleciona workflow-audit-live (issue #195, pino 1)", () => {
    const real = readSlices(SLICES);
    expect(slicesOf(["src/cli.ts"], real)).toEqual(["workflow-audit-live"]);
  });

  it("readSlices rejeita JSON sem a forma esperada", () => {
    const dir = mkdtempSync(join(tmpdir(), "slices-"));
    const path = join(dir, "slices.json");
    writeFileSync(path, JSON.stringify([{ slice: "x" }]));
    expect(() => readSlices(path)).toThrow(/slices\.json/);
  });
});

describe("mutations-matrix — CLI", () => {
  function run(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  it("--files-file + --slices imprime a matriz em JSON e escreve GITHUB_OUTPUT", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-"));
    const files = join(dir, "files.txt");
    const output = join(dir, "output.txt");
    writeFileSync(files, "src/web/fetch.ts\ndocs/x.md\n");
    const result = run(["--files-file", files, "--slices", SLICES], { GITHUB_OUTPUT: output });
    expect(result.status, result.stderr).toBe(0);
    const matrix = JSON.parse(result.stdout) as { count: number; include: { slice: string }[] };
    expect(matrix.count).toBe(1);
    expect(matrix.include[0]?.slice).toBe("web-tools");
    const saida = readFileSync(output, "utf8");
    expect(saida).toContain("count=1\n");
    expect(saida).toMatch(/^matrix=\[\{"slice":"web-tools"/m);
  });

  it("sem --base/--head nem --files-file sai 2 com mensagem de uso", () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--files-file|--base/);
  });
});

describe("mutations.yml — forma do workflow", () => {
  const yaml = existsSync(WORKFLOW) ? readFileSync(WORKFLOW, "utf8") : "";

  it("existe e dispara em toda pull_request, sem filtro de paths (#225: check required)", () => {
    expect(existsSync(WORKFLOW), "mutations.yml ausente").toBe(true);
    expect(yaml).toMatch(/^on:\n\s+pull_request:/m);
    // Sem `paths:`: um check required precisa reportar em toda PR; para diff
    // sem src/ o `plan` devolve count 0 e o job-resumo passa em segundos.
    expect(yaml).not.toMatch(/^\s+paths:/m);
  });

  it("job-resumo mutations (nome fixo para o ruleset) depende de plan e mutate, roda sempre e falha só em mutate failure/cancelled ou plan não-success", () => {
    const resumo = yaml.slice(yaml.indexOf("\n  mutations:"));
    expect(yaml, "job mutations ausente").toMatch(/^ {2}mutations:/m);
    expect(resumo).toMatch(/needs: \[plan, mutate\]/);
    expect(resumo).toMatch(/if: always\(\)/);
    expect(resumo).toContain("needs.plan.result");
    expect(resumo).toContain("needs.mutate.result");
    expect(resumo).toMatch(/skipped/);
    expect(resumo).toMatch(/exit 1/);
  });

  it("job plan usa fetch-depth 0 e o script mutations-matrix", () => {
    expect(yaml).toMatch(/^ {2}plan:/m);
    expect(yaml).toContain("fetch-depth: 0");
    expect(yaml).toContain("scripts/github/mutations-matrix.ts");
  });

  it("job mutate depende de plan, é guardado por count != 0 e usa a matriz de plan", () => {
    expect(yaml).toMatch(/^ {2}mutate:/m);
    expect(yaml).toContain("needs: plan");
    expect(yaml).toContain("needs.plan.outputs.count != '0'");
    expect(yaml).toContain("include: ${{ fromJson(needs.plan.outputs.matrix) }}");
    expect(yaml).toContain("npm run ${{ matrix.script }}");
  });

  it("mutate tem timeout e artefato por fatia", () => {
    expect(yaml).toMatch(/timeout-minutes: \d+/);
    expect(yaml).toContain("actions/upload-artifact@v4");
    expect(yaml).toContain("name: mutation-evidence-${{ matrix.slice }}");
    expect(yaml).toContain("path: .mutation-evidence/");
  });

  it("o step mutate liga pipefail antes do tee e grava o log da fatia (issue #325)", () => {
    const step = yaml.slice(
      yaml.indexOf("- name: ${{ matrix.slice }}"),
      yaml.indexOf("- uses: actions/upload-artifact"),
    );
    const indicePipefail = step.indexOf("set -o pipefail");
    const indiceTee = step.indexOf("| tee");
    expect(indicePipefail, "set -o pipefail ausente no step mutate").toBeGreaterThanOrEqual(0);
    expect(indiceTee, "| tee ausente no step mutate").toBeGreaterThanOrEqual(0);
    expect(indicePipefail).toBeLessThan(indiceTee);
    expect(step).toContain("mkdir -p .mutation-evidence");
    expect(step).toContain(
      'npm run ${{ matrix.script }} 2>&1 | tee ".mutation-evidence/${{ matrix.slice }}.log"',
    );
  });

  it("o upload-artifact do mutate roda sempre e aponta para .mutation-evidence/ (issue #325)", () => {
    const uploadInicio = yaml.indexOf("- uses: actions/upload-artifact");
    const upload = yaml.slice(uploadInicio, yaml.indexOf("mutations:", uploadInicio));
    expect(upload).toContain("if: always()");
    expect(upload).toContain("path: .mutation-evidence/");
  });

  it("o step do plan não engole o exit code do script (sem pipe; set +e / exit $status)", () => {
    const step = yaml
      .slice(yaml.indexOf("fatias que o diff exige"), yaml.indexOf("  mutate:"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(step).not.toMatch(/\|\s*tee/);
    expect(step).toContain("set +e");
    expect(step).toContain("status=$?");
    expect(step).toMatch(/exit \$status\s*$/m);
    expect(step).toContain("echo '```json'");
  });

  it("permissões mínimas e fail-fast desligado na matriz", () => {
    expect(yaml).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(yaml).toContain("fail-fast: false");
  });

  it("concurrency cancela run anterior da mesma ref", () => {
    expect(yaml).toContain("group: mutations-${{ github.ref }}");
    expect(yaml).toContain("cancel-in-progress: true");
  });

  it("não usa action de terceiros (só actions/*)", () => {
    const usos = [...yaml.matchAll(/uses: (\S+)/g)].map((m) => m[1] ?? "");
    expect(usos.length).toBeGreaterThan(0);
    for (const uso of usos) expect(uso, `action fora de actions/: ${uso}`).toMatch(/^actions\//);
  });
});
