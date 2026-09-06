// Bancada do `provenance:check` pós #159/rodada 2 da PR #172: classificador
// puro (SHA_UNKNOWN, NOT_ANCESTOR, SHALLOW_CLONE, PENDING) com `git`
// injetado — nunca `spawnSync` de verdade nesta parte da suíte — mais um
// bloco de CLI de ponta a ponta contra um repositório git temporário
// (`tests/helpers/controle-negativo-repo.ts`: `novoRepo`/`commitTudo`), via
// `--provenance <path>`. A rodada 1 rodava o e2e contra o
// `docs/provenance.json` real e o checkout deste repositório — reprovava no
// job `checks` porque o checkout do CI é raso (`SHALLOW_CLONE`, não
// `SHA_UNKNOWN`/`NOT_ANCESTOR`) e dependia do literal de T22. O repositório
// temporário é sempre um clone completo (`git init` local), então prova as
// causas que dependem de "não raso" sem depender da profundidade do clone
// deste repositório nem do conteúdo atual de `docs/provenance.json`. A
// matriz completa de causas em repositório temporário (incluindo um clone
// raso de verdade) fica para a #161.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyApproved,
  evaluateProvenance,
  isShallowClone,
  validateDocument,
  type GitResult,
  type GitRunner,
} from "../scripts/provenance/check-ancestry.js";
import type { ProvenanceDocument } from "../scripts/provenance/extract.js";
import { commitTudo, limparWorkdirs, novoRepo } from "./helpers/controle-negativo-repo.js";

const root = resolve(import.meta.dirname, "..");
const SHA = "5b2d62c65f282683609d5d3801b3bfaf4448aff4";
const SHA2 = "8901ea084e5797980650bd512f4fcd8fe251c952";

afterEach(limparWorkdirs);

/** `GitRunner` fake: mapa `"comando args" -> GitResult`. Lança se o
 * classificador chamar um comando não previsto — nunca cai silenciosamente
 * num resultado "sucesso" por omissão. */
function fakeGit(responses: Record<string, GitResult>): GitRunner {
  return (args) => {
    const key = args.join(" ");
    const found = responses[key];
    if (found === undefined) throw new Error(`git call não esperada pelo fake: ${key}`);
    return found;
  };
}

const shallowFalse = { "rev-parse --is-shallow-repository": { status: 0, stdout: "false\n" } };

describe("classifyApproved", () => {
  it("retorna null quando o SHA existe e é ancestral do HEAD", () => {
    const git = fakeGit({
      [`cat-file -e ${SHA}^{commit}`]: { status: 0, stdout: "" },
      [`merge-base --is-ancestor ${SHA} HEAD`]: { status: 0, stdout: "" },
    });
    expect(classifyApproved(git, SHA, false)).toBeNull();
  });

  it("SHA_UNKNOWN quando git cat-file -e falha e o repositório não é raso", () => {
    const git = fakeGit({
      [`cat-file -e ${SHA}^{commit}`]: { status: 1, stdout: "" },
    });
    expect(classifyApproved(git, SHA, false)).toBe("SHA_UNKNOWN");
  });

  it("NOT_ANCESTOR quando o SHA existe mas merge-base --is-ancestor falha", () => {
    const git = fakeGit({
      [`cat-file -e ${SHA}^{commit}`]: { status: 0, stdout: "" },
      [`merge-base --is-ancestor ${SHA} HEAD`]: { status: 1, stdout: "" },
    });
    expect(classifyApproved(git, SHA, false)).toBe("NOT_ANCESTOR");
  });

  it("SHALLOW_CLONE em vez de SHA_UNKNOWN quando o repositório é raso", () => {
    const git = fakeGit({
      [`cat-file -e ${SHA}^{commit}`]: { status: 1, stdout: "" },
    });
    expect(classifyApproved(git, SHA, true)).toBe("SHALLOW_CLONE");
  });

  it("SHALLOW_CLONE em vez de NOT_ANCESTOR quando o repositório é raso", () => {
    const git = fakeGit({
      [`cat-file -e ${SHA}^{commit}`]: { status: 0, stdout: "" },
      [`merge-base --is-ancestor ${SHA} HEAD`]: { status: 1, stdout: "" },
    });
    expect(classifyApproved(git, SHA, true)).toBe("SHALLOW_CLONE");
  });
});

describe("isShallowClone", () => {
  it("true quando rev-parse --is-shallow-repository imprime true", () => {
    const git = fakeGit({ "rev-parse --is-shallow-repository": { status: 0, stdout: "true\n" } });
    expect(isShallowClone(git)).toBe(true);
  });

  it("false quando imprime false", () => {
    const git = fakeGit(shallowFalse);
    expect(isShallowClone(git)).toBe(false);
  });
});

describe("evaluateProvenance", () => {
  it("ok quando toda entrada approved é ancestral", () => {
    const document: ProvenanceDocument = {
      entries: [{ ticket: "T00", sha: SHA, result: "integrado", status: "approved" }],
    };
    const git = fakeGit({
      ...shallowFalse,
      [`cat-file -e ${SHA}^{commit}`]: { status: 0, stdout: "" },
      [`merge-base --is-ancestor ${SHA} HEAD`]: { status: 0, stdout: "" },
    });
    expect(evaluateProvenance(document, git, { pendingOk: false })).toEqual({
      checked: 1,
      ok: true,
      failures: [],
      skipped: 0,
      tolerated: 0,
    });
  });

  it("reporta NOT_ANCESTOR sem confundir com SHA_UNKNOWN", () => {
    const document: ProvenanceDocument = {
      entries: [{ ticket: "T00", sha: SHA, result: "integrado", status: "approved" }],
    };
    const git = fakeGit({
      ...shallowFalse,
      [`cat-file -e ${SHA}^{commit}`]: { status: 0, stdout: "" },
      [`merge-base --is-ancestor ${SHA} HEAD`]: { status: 1, stdout: "" },
    });
    expect(evaluateProvenance(document, git, { pendingOk: false })).toEqual({
      checked: 1,
      ok: false,
      failures: [{ ticket: "T00", sha: SHA, cause: "NOT_ANCESTOR" }],
      skipped: 0,
      tolerated: 0,
    });
  });

  it("conta um pending com placeholder (SHA não-40-hex) como skipped, nunca falha", () => {
    const document: ProvenanceDocument = {
      entries: [
        { ticket: "T22", sha: "EVIDENCE_BOUND_FINAL_SHA", result: "pendente", status: "pending" },
      ],
    };
    const git = fakeGit(shallowFalse);
    expect(evaluateProvenance(document, git, { pendingOk: false })).toEqual({
      checked: 0,
      ok: true,
      failures: [],
      skipped: 1,
      tolerated: 0,
    });
  });

  it("reprova um pending com SHA real de 40 hex quando --pending-ok está ausente", () => {
    const document: ProvenanceDocument = {
      entries: [{ ticket: "T23", sha: SHA2, result: "pendente", status: "pending" }],
    };
    const git = fakeGit(shallowFalse);
    expect(evaluateProvenance(document, git, { pendingOk: false })).toEqual({
      checked: 0,
      ok: false,
      failures: [{ ticket: "T23", sha: SHA2, cause: "PENDING" }],
      skipped: 0,
      tolerated: 0,
    });
  });

  it("tolera um pending com SHA real de 40 hex quando --pending-ok está presente, e conta em tolerated", () => {
    const document: ProvenanceDocument = {
      entries: [{ ticket: "T23", sha: SHA2, result: "pendente", status: "pending" }],
    };
    const git = fakeGit(shallowFalse);
    expect(evaluateProvenance(document, git, { pendingOk: true })).toEqual({
      checked: 0,
      ok: true,
      failures: [],
      skipped: 0,
      tolerated: 1,
    });
  });

  it("mistura approved e pending de forma independente", () => {
    const document: ProvenanceDocument = {
      entries: [
        { ticket: "T00", sha: SHA, result: "integrado", status: "approved" },
        { ticket: "T22", sha: "EVIDENCE_BOUND_FINAL_SHA", result: "pendente", status: "pending" },
      ],
    };
    const git = fakeGit({
      ...shallowFalse,
      [`cat-file -e ${SHA}^{commit}`]: { status: 0, stdout: "" },
      [`merge-base --is-ancestor ${SHA} HEAD`]: { status: 0, stdout: "" },
    });
    expect(evaluateProvenance(document, git, { pendingOk: false })).toEqual({
      checked: 1,
      ok: true,
      failures: [],
      skipped: 1,
      tolerated: 0,
    });
  });
});

describe("validateDocument (guarda fail-closed: pelo menos uma entrada approved)", () => {
  it("lança PROVENANCE_EMPTY quando não há nenhuma entrada", () => {
    expect(() => {
      validateDocument({ entries: [] }, "docs/provenance.json");
    }).toThrow(/PROVENANCE_EMPTY:docs\/provenance\.json:no approved entries found/u);
  });

  it("lança PROVENANCE_EMPTY quando só há entradas pending — a regressão da rodada 1", () => {
    expect(() => {
      validateDocument(
        {
          entries: [
            {
              ticket: "T22",
              sha: "EVIDENCE_BOUND_FINAL_SHA",
              result: "pendente",
              status: "pending",
            },
          ],
        },
        "docs/provenance.json",
      );
    }).toThrow(/PROVENANCE_EMPTY/u);
  });

  it("não lança quando há pelo menos uma entrada approved", () => {
    expect(() => {
      validateDocument(
        {
          entries: [
            { ticket: "T00", sha: SHA, result: "integrado", status: "approved" },
            {
              ticket: "T22",
              sha: "EVIDENCE_BOUND_FINAL_SHA",
              result: "pendente",
              status: "pending",
            },
          ],
        },
        "docs/provenance.json",
      );
    }).not.toThrow();
  });
});

describe("provenance:check CLI (ponta a ponta, repositório git temporário)", () => {
  // Issue #137: nunca pelo wrapper CLI do `tsx` — `--import` com o loader
  // direto evita o handshake de sinal do wrapper (molde: tests/ci-escopo.test.ts).
  const tsxLoader = import.meta.resolve("tsx");
  const script = resolve(root, "scripts/provenance/check-ancestry.ts");

  function run(dir: string, args: readonly string[]) {
    return spawnSync(process.execPath, ["--import", tsxLoader, script, ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  }

  function escreverProvenance(dir: string, entries: readonly unknown[]): string {
    const path = join(dir, "provenance.json");
    writeFileSync(path, JSON.stringify({ entries }));
    return path;
  }

  it("passa e emite --json contra um repositório de verdade, sem depender da profundidade do clone", () => {
    const dir = novoRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    const sha1 = commitTudo(dir, "feat: primeiro commit");
    writeFileSync(join(dir, "b.txt"), "b\n");
    const sha2 = commitTudo(dir, "feat: segundo commit");
    const provenancePath = escreverProvenance(dir, [
      { ticket: "T00", sha: sha1, result: "integrado", status: "approved" },
      { ticket: "T01", sha: sha2, result: "integrado", status: "approved" },
      { ticket: "T99", sha: "PLACEHOLDER", result: "pendente", status: "pending" },
    ]);

    const textResult = run(dir, ["--provenance", provenancePath]);
    expect(textResult.status).toBe(0);
    expect(textResult.stdout).toBe("provenance: 2/2 approved heads are ancestors of HEAD\n");
    expect(textResult.stderr).toContain("T99 skipped — not a full SHA: PLACEHOLDER");

    const jsonResult = run(dir, ["--provenance", provenancePath, "--json"]);
    expect(jsonResult.status).toBe(0);
    expect(JSON.parse(jsonResult.stdout)).toEqual({
      checked: 2,
      ok: true,
      failures: [],
      skipped: 1,
      tolerated: 0,
    });
  });

  it("reporta SHA_UNKNOWN — não SHALLOW_CLONE — para um SHA inexistente num repositório não raso", () => {
    const dir = novoRepo();
    const sha1 = commitTudo(dir, "feat: único commit");
    const shaInexistente = "a".repeat(40);
    const provenancePath = escreverProvenance(dir, [
      { ticket: "T00", sha: sha1, result: "integrado", status: "approved" },
      { ticket: "T01", sha: shaInexistente, result: "integrado", status: "approved" },
    ]);

    const result = run(dir, ["--provenance", provenancePath, "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      checked: 2,
      ok: false,
      failures: [{ ticket: "T01", sha: shaInexistente, cause: "SHA_UNKNOWN" }],
      skipped: 0,
      tolerated: 0,
    });
  });

  it("PROVENANCE_EMPTY (exit 2) quando não há nenhuma entrada approved — guarda restaurada", () => {
    const dir = novoRepo();
    commitTudo(dir, "feat: único commit");
    const provenancePath = escreverProvenance(dir, [
      { ticket: "T99", sha: "PLACEHOLDER", result: "pendente", status: "pending" },
    ]);

    const result = run(dir, ["--provenance", provenancePath]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("PROVENANCE_EMPTY");
  });

  it("PROVENANCE_EMPTY também para uma lista de entradas totalmente vazia", () => {
    const dir = novoRepo();
    commitTudo(dir, "feat: único commit");
    const provenancePath = escreverProvenance(dir, []);

    const result = run(dir, ["--provenance", provenancePath]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("PROVENANCE_EMPTY");
  });
});
