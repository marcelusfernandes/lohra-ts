// Testes de `scripts/mutations/all.ts` (issue #155, passo 11 de
// `orquestracao.md`). Nunca roda as seis fatias reais (lento — cada corrida
// pode levar até 20 minutos, `RUN_TIMEOUT_MS`); todo cenário aqui injeta um
// `execute` falso, no espírito de `tests/mutations-harness.test.ts` (#148/
// #149), que testa o harness comum sem rodar mutação de verdade.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildReport,
  evaluateRun,
  extractJsonLine,
  parseSliceReport,
  readSliceConfigs,
  runAllSlices,
  runSliceTwice,
  writeAllEvidence,
  type AllMutationsReport,
  type RunResult,
  type SliceConfig,
  type SliceOutcome,
} from "../scripts/mutations/all.js";

const repoRoot = resolve(import.meta.dirname, "..");

const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mutations-all-"));
  workdirs.push(dir);
  return dir;
}

/** Uma linha JSON de relatório de fatia, no mesmo formato que os seis
 * runners de `scripts/mutations/*.ts` já emitem. */
function reportLine(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    suite: "fake-suite",
    candidateSha: "deadbeef",
    killed: 3,
    total: 3,
    survivors: [],
    restoreGreen: true,
    ...overrides,
  });
}

function okRun(overrides: Partial<Record<string, unknown>> = {}): RunResult {
  return { status: 0, stdout: `${reportLine(overrides)}\n`, stderr: "" };
}

describe("readSliceConfigs", () => {
  it("lê slice/script de um slices.json válido", () => {
    const dir = workdir();
    const path = join(dir, "slices.json");
    writeFileSync(
      path,
      JSON.stringify([
        { slice: "a", script: "mutations:a", catalog: [], srcGlobs: [], focusFiles: [] },
        { slice: "b", script: "mutations:b", catalog: [], srcGlobs: [], focusFiles: [] },
      ]),
      "utf8",
    );
    expect(readSliceConfigs(path)).toEqual([
      { slice: "a", script: "mutations:a" },
      { slice: "b", script: "mutations:b" },
    ]);
  });

  it("lê o scripts/mutations/slices.json de verdade (seis fatias, script não-vazio)", () => {
    const configs = readSliceConfigs();
    expect(configs).toHaveLength(6);
    for (const config of configs) {
      expect(config.slice.length).toBeGreaterThan(0);
      expect(config.script.length).toBeGreaterThan(0);
    }
  });

  it("lança se o topo não é um array", () => {
    const dir = workdir();
    const path = join(dir, "slices.json");
    writeFileSync(path, JSON.stringify({ not: "an array" }), "utf8");
    expect(() => readSliceConfigs(path)).toThrow(/esperava um array/);
  });

  it('lança se uma entrada não tem "slice" string não-vazia', () => {
    const dir = workdir();
    const path = join(dir, "slices.json");
    writeFileSync(path, JSON.stringify([{ script: "mutations:a" }]), "utf8");
    expect(() => readSliceConfigs(path)).toThrow(/"slice"/);
  });

  it('lança se uma entrada não tem "script" string não-vazia', () => {
    const dir = workdir();
    const path = join(dir, "slices.json");
    writeFileSync(path, JSON.stringify([{ slice: "a" }]), "utf8");
    expect(() => readSliceConfigs(path)).toThrow(/"script"/);
  });
});

describe("extractJsonLine", () => {
  it("extrai a última linha que parece um objeto JSON completo", () => {
    const output = 'ruído qualquer\n{"a":1}\nmais ruído\n{"b":2}\n';
    expect(extractJsonLine(output, "ctx")).toBe('{"b":2}');
  });

  it("lança se nenhuma linha bate", () => {
    expect(() => extractJsonLine("sem json nenhum aqui\n", "ctx")).toThrow(
      /MUTATION_ALL_NO_REPORT:ctx/,
    );
  });
});

describe("parseSliceReport", () => {
  it("aceita um relatório válido", () => {
    const parsed = parseSliceReport(reportLine(), "ctx");
    expect(parsed).toEqual({
      suite: "fake-suite",
      candidateSha: "deadbeef",
      killed: 3,
      total: 3,
      survivors: [],
      restoreGreen: true,
    });
  });

  it('lança se "survivors" não é string[]', () => {
    expect(() => parseSliceReport(reportLine({ survivors: "not-an-array" }), "ctx")).toThrow(
      /MUTATION_ALL_BAD_REPORT:ctx:survivors/,
    );
  });

  it('lança se "restoreGreen" não é boolean', () => {
    expect(() => parseSliceReport(reportLine({ restoreGreen: "yes" }), "ctx")).toThrow(
      /MUTATION_ALL_BAD_REPORT:ctx:restoreGreen/,
    );
  });

  it("lança se o JSON não é um objeto", () => {
    expect(() => parseSliceReport("[1,2,3]", "ctx")).toThrow(/MUTATION_ALL_BAD_REPORT:ctx/);
  });
});

describe("evaluateRun", () => {
  it("extrai relatório e digest de uma corrida", () => {
    const run = okRun();
    const outcome = evaluateRun(run, "ctx");
    expect(outcome.report.suite).toBe("fake-suite");
    expect(outcome.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o mesmo texto produz o mesmo digest", () => {
    const a = evaluateRun(okRun(), "ctx");
    const b = evaluateRun(okRun(), "ctx");
    expect(a.digest).toBe(b.digest);
  });
});

const fakeSlice: SliceConfig = { slice: "fake", script: "mutations:fake" };

describe("runSliceTwice", () => {
  it("agrega as duas corridas idênticas num SliceOutcome com digest comum", () => {
    let calls = 0;
    const outcome = runSliceTwice(fakeSlice, () => {
      calls += 1;
      return okRun();
    });
    expect(calls).toBe(2);
    expect(outcome).toEqual({
      slice: "fake",
      script: "mutations:fake",
      suite: "fake-suite",
      candidateSha: "deadbeef",
      killed: 3,
      total: 3,
      survivors: [],
      restoreGreen: true,
      digest: evaluateRun(okRun(), "ctx").digest,
    });
  });

  // AC2: sobrevivente injetado à mão numa fatia faz sair 1 nomeando a fatia
  // e o id.
  it("lança nomeando a fatia e o id quando a primeira corrida tem sobrevivente", () => {
    let calls = 0;
    expect(() =>
      runSliceTwice(fakeSlice, () => {
        calls += 1;
        return calls === 1 ? okRun({ survivors: ["T-survivor-1"] }) : okRun();
      }),
    ).toThrow(/MUTATION_SURVIVOR:fake:T-survivor-1/);
  });

  it("lança nomeando a fatia e o id quando a segunda corrida tem sobrevivente", () => {
    let calls = 0;
    expect(() =>
      runSliceTwice(fakeSlice, () => {
        calls += 1;
        return calls === 2 ? okRun({ survivors: ["T-survivor-2"] }) : okRun();
      }),
    ).toThrow(/MUTATION_SURVIVOR:fake:T-survivor-2/);
  });

  it("lança quando restoreGreen vem false em qualquer corrida", () => {
    expect(() => runSliceTwice(fakeSlice, () => okRun({ restoreGreen: false }))).toThrow(
      /MUTATION_RESTORE_NOT_GREEN:fake/,
    );
  });

  // AC3: digests divergentes entre as duas corridas saem 1 com
  // MUTATION_NONDETERMINISTIC.
  it("lança MUTATION_NONDETERMINISTIC quando os digests das duas corridas divergem", () => {
    let calls = 0;
    expect(() =>
      runSliceTwice(fakeSlice, () => {
        calls += 1;
        return calls === 1 ? okRun({ killed: 3 }) : okRun({ killed: 2, survivors: [] });
      }),
    ).toThrow(/MUTATION_NONDETERMINISTIC:fake/);
  });

  it("não lança MUTATION_NONDETERMINISTIC para duas corridas byte-a-byte iguais", () => {
    expect(() => runSliceTwice(fakeSlice, () => okRun())).not.toThrow();
  });
});

describe("runAllSlices", () => {
  it("roda cada fatia na ordem e agrega os outcomes", () => {
    const slices: readonly SliceConfig[] = [
      { slice: "one", script: "mutations:one" },
      { slice: "two", script: "mutations:two" },
    ];
    const seen: string[] = [];
    const outcomes = runAllSlices(slices, (script) => {
      seen.push(script);
      return okRun();
    });
    expect(seen).toEqual(["mutations:one", "mutations:one", "mutations:two", "mutations:two"]);
    expect(outcomes.map((outcome) => outcome.slice)).toEqual(["one", "two"]);
  });

  it("para na primeira fatia que falhar, sem rodar as seguintes", () => {
    const slices: readonly SliceConfig[] = [
      { slice: "one", script: "mutations:one" },
      { slice: "two", script: "mutations:two" },
    ];
    const seen: string[] = [];
    expect(() =>
      runAllSlices(slices, (script) => {
        seen.push(script);
        return okRun({ survivors: ["T-x"] });
      }),
    ).toThrow(/MUTATION_SURVIVOR:one:T-x/);
    expect(seen).toEqual(["mutations:one"]);
  });
});

function fakeOutcome(overrides: Partial<SliceOutcome> = {}): SliceOutcome {
  return {
    slice: "fake",
    script: "mutations:fake",
    suite: "fake-suite",
    candidateSha: "deadbeef",
    killed: 3,
    total: 3,
    survivors: [],
    restoreGreen: true,
    digest: "abc123",
    ...overrides,
  };
}

describe("buildReport", () => {
  it("agrega os outcomes sob o candidateSha comum", () => {
    const report = buildReport([fakeOutcome({ slice: "a" }), fakeOutcome({ slice: "b" })]);
    expect(report.candidateSha).toBe("deadbeef");
    expect(report.slices.map((s) => s.slice)).toEqual(["a", "b"]);
  });

  it("lança se a lista de fatias vier vazia", () => {
    expect(() => buildReport([])).toThrow(/MUTATION_ALL_EMPTY_SLICES/);
  });

  it("lança se alguma fatia relata candidateSha diferente da primeira", () => {
    expect(() =>
      buildReport([
        fakeOutcome({ slice: "a", candidateSha: "sha-a" }),
        fakeOutcome({ slice: "b", candidateSha: "sha-b" }),
      ]),
    ).toThrow(/MUTATION_ALL_SHA_MISMATCH/);
  });
});

describe("writeAllEvidence", () => {
  it("escreve o relatório em JSON canônico no caminho dado", () => {
    const dir = workdir();
    const path = join(dir, "nested", "all.json");
    const report: AllMutationsReport = buildReport([fakeOutcome()]);
    writeAllEvidence(report, path);
    expect(existsSync(path)).toBe(true);
    const written: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(written).toEqual(report);
  });
});

describe("package.json", () => {
  it("declara mutations:all rodando scripts/mutations/all.ts", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    expect(packageJson.scripts?.["mutations:all"]).toBe("tsx scripts/mutations/all.ts");
  });
});
