// Bancada do `provenance:check` pós #159: classificador puro (SHA_UNKNOWN,
// NOT_ANCESTOR, SHALLOW_CLONE, PENDING) com `git` injetado — nunca
// `spawnSync` de verdade nesta suíte — mais um caso mínimo de CLI de ponta a
// ponta contra o `docs/provenance.json` real (um repositório temporário
// completo, com histórico fabricado, fica para a #161).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyApproved,
  evaluateProvenance,
  isShallowClone,
  validateDocument,
  type GitResult,
  type GitRunner,
} from "../scripts/provenance/check-ancestry.js";
import type { ProvenanceDocument } from "../scripts/provenance/extract.js";

const root = resolve(import.meta.dirname, "..");
const SHA = "5b2d62c65f282683609d5d3801b3bfaf4448aff4";
const SHA2 = "8901ea084e5797980650bd512f4fcd8fe251c952";

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
    });
  });

  it("tolera um pending com SHA real de 40 hex quando --pending-ok está presente", () => {
    const document: ProvenanceDocument = {
      entries: [{ ticket: "T23", sha: SHA2, result: "pendente", status: "pending" }],
    };
    const git = fakeGit(shallowFalse);
    expect(evaluateProvenance(document, git, { pendingOk: true })).toEqual({
      checked: 0,
      ok: true,
      failures: [],
      skipped: 0,
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
    });
  });
});

describe("validateDocument (guarda de lista vazia)", () => {
  it("lança quando não há nenhuma entrada", () => {
    expect(() => {
      validateDocument({ entries: [] });
    }).toThrow(/no entries/u);
  });

  it("não lança para um documento com entradas", () => {
    expect(() => {
      validateDocument({
        entries: [{ ticket: "T00", sha: SHA, result: "integrado", status: "approved" }],
      });
    }).not.toThrow();
  });
});

describe("provenance:check CLI (caso mínimo de ponta a ponta)", () => {
  // Issue #137: nunca pelo wrapper CLI do `tsx` — `--import` com o loader
  // direto evita o handshake de sinal do wrapper (molde:
  // tests/ci-escopo.test.ts).
  const tsxLoader = import.meta.resolve("tsx");
  const script = resolve(root, "scripts/provenance/check-ancestry.ts");

  function run(args: readonly string[]) {
    return spawnSync(process.execPath, ["--import", tsxLoader, script, ...args], {
      cwd: root,
      encoding: "utf8",
    });
  }

  it("sem flags, passa contra o docs/provenance.json real e preserva o texto atual", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^provenance: \d+\/\d+ approved heads are ancestors of HEAD\n$/u);
    expect(result.stderr).toContain("T22 skipped — not a full SHA");
  });

  it("--json emite {checked, ok, failures, skipped}", () => {
    const result = run(["--json"]);
    expect(result.status).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ ok: true, failures: [], skipped: 1 });
    expect((parsed as { checked: number }).checked).toBeGreaterThan(0);
  });
});
