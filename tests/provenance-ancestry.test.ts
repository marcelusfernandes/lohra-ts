// Issue #161: matriz de causas de `check-ancestry.ts` contra um repositório
// git DESCARTÁVEL (`mkdtemp`, molde `tests/helpers/controle-negativo-repo.ts`
// — `novoRepo`/`commitTudo`/`git`/`gitCapture`), sempre por CLI de ponta a
// ponta (`--provenance <path>`, cwd = o repositório temporário). Nenhum caso
// aqui lê `docs/provenance.json` real nem depende do histórico deste
// repositório — mudar `check-ancestry.ts` nunca deveria mexer nestes testes
// por causa de um SHA que só existe no HEAD de verdade.
//
// `tests/provenance-check.test.ts:252-339` já cobre, também em repositório
// temporário: ancestral ok (`--json`, exit 0), `SHA_UNKNOWN` (SHA de 40 hex
// inexistente) e `PROVENANCE_EMPTY` (placeholder pending + lista vazia). Este
// arquivo cobre o resto da matriz da issue #161, sem duplicar nenhum desses
// três: `NOT_ANCESTOR` (commit numa branch órfã/divergente, nunca mesclada),
// `PENDING` com SHA real com e sem `--pending-ok` (a causa `PENDING` e o
// contador `tolerated`), JSON malformado (`PROVENANCE_INVALID_JSON`, exit 2),
// uma lista só-`pending` com SHA REAL (não placeholder) ainda reprovando com
// `PROVENANCE_EMPTY` — prova que a guarda roda antes de classificar
// `PENDING`, não só antes de contar placeholders —, um clone raso FABRICADO
// (`git clone --depth 1 file://<origem>`, nunca o clone deste repositório) e
// `--provenance` sem valor (ramo sem teste antes desta issue).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  commitTudo,
  git,
  gitCapture,
  limparWorkdirs,
  novoRepo,
} from "./helpers/controle-negativo-repo.js";

const root = resolve(import.meta.dirname, "..");
const TIMEOUT_TESTE = 60_000;

afterEach(limparWorkdirs);

// `novoRepo`/`commitTudo` (via `limparWorkdirs`) só limpam os diretórios que
// eles próprios criam. O clone raso fabricado nasce de um `mkdtempSync`
// separado (não de `novoRepo`) — precisa da sua própria limpeza.
const workdirsExtras: string[] = [];
afterEach(() => {
  while (workdirsExtras.length > 0) {
    const dir = workdirsExtras.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("provenance:check CLI — matriz de causas em repositório git temporário (issue #161)", () => {
  // Issue #137: nunca pelo wrapper CLI do `tsx` — `--import` com o loader
  // direto (mesmo idioma de `tests/provenance-check.test.ts`).
  const tsxLoader = import.meta.resolve("tsx");
  const script = resolve(root, "scripts/provenance/check-ancestry.ts");

  function run(dir: string, args: readonly string[]) {
    return spawnSync(process.execPath, ["--import", tsxLoader, script, ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  }

  function escreverProvenance(dir: string, conteudo: unknown): string {
    const path = join(dir, "provenance.json");
    writeFileSync(path, typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo));
    return path;
  }

  it("NOT_ANCESTOR — SHA existe no repositório (branch órfã/divergente) mas não é ancestral do HEAD", () => {
    const dir = novoRepo();
    commitTudo(dir, "feat: commit inicial");
    git(dir, ["checkout", "-b", "outra"]);
    writeFileSync(join(dir, "divergente.txt"), "x\n");
    const shaDivergente = commitTudo(dir, "feat: commit só na branch 'outra', nunca mesclado");
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "main.txt"), "y\n");
    commitTudo(dir, "feat: commit em main, sem mesclar 'outra'");

    const provenancePath = escreverProvenance(dir, {
      entries: [{ ticket: "T00", sha: shaDivergente, result: "integrado", status: "approved" }],
    });

    const result = run(dir, ["--provenance", provenancePath, "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      checked: 1,
      ok: false,
      failures: [{ ticket: "T00", sha: shaDivergente, cause: "NOT_ANCESTOR" }],
      skipped: 0,
      tolerated: 0,
    });
  });

  it("PENDING com SHA real reprova sem --pending-ok, sem afetar o approved que passa", () => {
    const dir = novoRepo();
    const shaAprovado = commitTudo(dir, "feat: commit aprovado");
    writeFileSync(join(dir, "b.txt"), "b\n");
    const shaPendente = commitTudo(dir, "feat: commit ainda sem decisão fechada");

    const provenancePath = escreverProvenance(dir, {
      entries: [
        { ticket: "T00", sha: shaAprovado, result: "integrado", status: "approved" },
        { ticket: "T01", sha: shaPendente, result: "pendente", status: "pending" },
      ],
    });

    const result = run(dir, ["--provenance", provenancePath, "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      checked: 1,
      ok: false,
      failures: [{ ticket: "T01", sha: shaPendente, cause: "PENDING" }],
      skipped: 0,
      tolerated: 0,
    });
  });

  it("PENDING com SHA real é tolerado com --pending-ok — entra em tolerated, nunca em failures", () => {
    const dir = novoRepo();
    const shaAprovado = commitTudo(dir, "feat: commit aprovado");
    writeFileSync(join(dir, "b.txt"), "b\n");
    const shaPendente = commitTudo(dir, "feat: commit ainda sem decisão fechada");

    const provenancePath = escreverProvenance(dir, {
      entries: [
        { ticket: "T00", sha: shaAprovado, result: "integrado", status: "approved" },
        { ticket: "T01", sha: shaPendente, result: "pendente", status: "pending" },
      ],
    });

    const result = run(dir, ["--provenance", provenancePath, "--pending-ok", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      checked: 1,
      ok: true,
      failures: [],
      skipped: 0,
      tolerated: 1,
    });
  });

  it("lista só-pending com SHA REAL (não placeholder) ainda sai PROVENANCE_EMPTY — a guarda roda antes de classificar PENDING", () => {
    const dir = novoRepo();
    const shaPendente = commitTudo(dir, "feat: único commit, nunca aprovado");
    const provenancePath = escreverProvenance(dir, {
      entries: [{ ticket: "T01", sha: shaPendente, result: "pendente", status: "pending" }],
    });

    const result = run(dir, ["--provenance", provenancePath, "--json"]);
    expect(result.status).toBe(2);
    // Nada de JSON no stdout: a guarda lança antes de `evaluateProvenance`
    // rodar, então a causa PENDING desse SHA nunca chega a ser calculada.
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("PROVENANCE_EMPTY");
  });

  it("JSON malformado sai 2 com a causa PROVENANCE_INVALID_JSON, nunca tratado como lista vazia", () => {
    const dir = novoRepo();
    commitTudo(dir, "feat: commit qualquer");
    const provenancePath = escreverProvenance(dir, "{ isto não é json");

    const result = run(dir, ["--provenance", provenancePath, "--json"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/PROVENANCE_INVALID_JSON/u);
  });

  it("--provenance sem valor sai 2 antes de tentar ler qualquer arquivo", () => {
    const dir = novoRepo();
    commitTudo(dir, "feat: commit qualquer");

    const result = run(dir, ["--provenance"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/--provenance requires a value/u);
  });

  it(
    "SHALLOW_CLONE — clone raso FABRICADO (git clone --depth 1) troca SHA_UNKNOWN pela causa honesta",
    () => {
      const origem = novoRepo();
      const shaAntigo = commitTudo(origem, "feat: commit antigo (fora do clone raso)");
      writeFileSync(join(origem, "b.txt"), "b\n");
      commitTudo(origem, "feat: commit recente (tip do clone raso)");

      const baseTmp = mkdtempSync(join(tmpdir(), "provenance-shallow-"));
      workdirsExtras.push(baseTmp);
      const rasoDir = join(baseTmp, "raso");
      const cloneResult = spawnSync(
        "git",
        ["clone", "-q", "--depth", "1", pathToFileURL(origem).href, rasoDir],
        { encoding: "utf8" },
      );
      expect(cloneResult.status).toBe(0);
      // Precondição explícita: se isto não for "true", a causa esperada
      // adiante seria SHA_UNKNOWN, não SHALLOW_CLONE — falharia longe da
      // causa real do problema.
      expect(gitCapture(rasoDir, ["rev-parse", "--is-shallow-repository"])).toBe("true");

      const provenancePath = escreverProvenance(rasoDir, {
        entries: [{ ticket: "T00", sha: shaAntigo, result: "integrado", status: "approved" }],
      });

      const result = run(rasoDir, ["--provenance", provenancePath, "--json"]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        checked: 1,
        ok: false,
        failures: [{ ticket: "T00", sha: shaAntigo, cause: "SHALLOW_CLONE" }],
        skipped: 0,
        tolerated: 0,
      });
    },
    TIMEOUT_TESTE,
  );
});
