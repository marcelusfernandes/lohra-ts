// Testes de `scripts/mutations/all.ts` (issue #155, passo 11 de
// `orquestracao.md`). Nunca roda as sete fatias reais (lento — cada corrida
// pode levar até 20 minutos, `RUN_TIMEOUT_MS`); todo cenário aqui injeta um
// `execute` falso, no espírito de `tests/mutations-harness.test.ts` (#148/
// #149), que testa o harness comum sem rodar mutação de verdade.
import { spawnSync } from "node:child_process";
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
  realExecute,
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

/** Um diretório temporário com o próprio `package.json` (`scripts`) — para
 * `realExecute` de verdade sem tocar o `package.json` do repo (issue #196,
 * `Files` não inclui `package.json`). */
function fakeProjectDir(scripts: Record<string, string>): string {
  const dir = workdir();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fake-mutations-all-project", version: "0.0.0", scripts }),
    "utf8",
  );
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
  return { status: 0, signal: null, stdout: `${reportLine(overrides)}\n`, stderr: "" };
}

/** Processo morto por sinal sem timeout (`error` ausente) — issue #196,
 * `MUTATION_ALL_KILLED:<fatia>:<sinal>`. */
function killedRun(signal: NodeJS.Signals): RunResult {
  return { status: null, signal, stdout: "", stderr: "" };
}

/** Timeout do `spawnSync`: `status` null, `signal` o `killSignal` (default
 * `SIGTERM`) e `error.code === "ETIMEDOUT"` — issue #196,
 * `MUTATION_ALL_TIMEOUT:<fatia>`. */
function timeoutRun(): RunResult {
  const error = Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" });
  return { status: null, signal: "SIGTERM", stdout: "", stderr: "", error };
}

/** Relatório limpo, mas o processo sai com `status` != 0 — issue #196,
 * `MUTATION_ALL_EXIT:<fatia>:<status>`. */
function exitRun(status: number, overrides: Partial<Record<string, unknown>> = {}): RunResult {
  return { status, signal: null, stdout: `${reportLine(overrides)}\n`, stderr: "" };
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

  it("lê o scripts/mutations/slices.json de verdade (sete fatias, script não-vazio)", () => {
    const configs = readSliceConfigs();
    expect(configs).toHaveLength(7);
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

  // issue #196, achado 1 do revisor da PR #194: timeout do `spawnSync`
  // nomeia a fatia, em vez de vazar `ETIMEDOUT` sem contexto.
  it("lança MUTATION_ALL_TIMEOUT nomeando a fatia quando error.code é ETIMEDOUT", () => {
    expect(() => evaluateRun(timeoutRun(), "ctx")).toThrow(/^MUTATION_ALL_TIMEOUT:ctx$/);
  });

  // issue #196, achado 1: sinal externo sem timeout inclui o sinal na causa.
  it("lança MUTATION_ALL_KILLED com o sinal quando o processo morre sem ser por timeout", () => {
    expect(() => evaluateRun(killedRun("SIGKILL"), "ctx")).toThrow(
      /^MUTATION_ALL_KILLED:ctx:SIGKILL$/,
    );
  });

  it("MUTATION_ALL_KILLED nomeia o sinal certo mesmo que outro seja usado", () => {
    expect(() => evaluateRun(killedRun("SIGTERM"), "ctx")).toThrow(
      /^MUTATION_ALL_KILLED:ctx:SIGTERM$/,
    );
  });

  // issue #196, rodada 2 (revisão da PR #200): `npm run <script>` sempre
  // passa por um shell entre `spawnSync` e o script; no Linux da CI, esse
  // shell converte morte por sinal em `status` 128+n em vez de propagar
  // `signal` (137 = 128+SIGKILL, 143 = 128+SIGTERM) — no macOS o sinal chega
  // direto. `evaluateRun` trata os dois caminhos como o mesmo fault.
  it("lança MUTATION_ALL_KILLED:SIGKILL quando status é 137 (128+SIGKILL) sem signal", () => {
    expect(() => evaluateRun(exitRun(137), "ctx")).toThrow(/^MUTATION_ALL_KILLED:ctx:SIGKILL$/);
  });

  it("lança MUTATION_ALL_KILLED:SIGTERM quando status é 143 (128+SIGTERM) sem signal", () => {
    expect(() => evaluateRun(exitRun(143), "ctx")).toThrow(/^MUTATION_ALL_KILLED:ctx:SIGTERM$/);
  });

  it("cai para o literal 128+n quando o código >= 128 não mapeia para nenhum sinal conhecido", () => {
    expect(() => evaluateRun(exitRun(200), "ctx")).toThrow(/^MUTATION_ALL_KILLED:ctx:128\+72$/);
  });

  // issue #196, achado 2 do revisor da PR #194: relatório limpo não é
  // suficiente — status != 0 é fault, mesmo com report parseável.
  it("lança MUTATION_ALL_EXIT nomeando a fatia e o status quando o relatório sai limpo mas o processo sai != 0", () => {
    expect(() => evaluateRun(exitRun(3), "ctx")).toThrow(/^MUTATION_ALL_EXIT:ctx:3$/);
  });

  it("não lança quando status é 0 e o relatório é limpo", () => {
    expect(() => evaluateRun(okRun(), "ctx")).not.toThrow();
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

// issue #196, achado 3 do revisor da PR #194: `realExecute` nunca tinha
// teste — a metade de falha ponta a ponta de `mutations:all` (timeout,
// sinal, exit != 0) nunca era exercitada de verdade. `npm run <script>` de
// cada cenário abaixo roda dentro de um `package.json` falso, num diretório
// temporário — nunca o `package.json` do repo.
describe("realExecute", () => {
  it("MUTATION_ALL_TIMEOUT: mata o script que dorme além do timeout e marca error.code ETIMEDOUT", () => {
    const dir = fakeProjectDir({
      sleep: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
    });
    const run = realExecute("sleep", { cwd: dir, timeoutMs: 300 });
    expect(run.status).toBeNull();
    expect(run.signal).toBe("SIGTERM");
    expect(run.error?.message).toMatch(/ETIMEDOUT/);
    expect((run.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
  }, 10_000);

  // issue #196, rodada 2 (revisão da PR #200): `npm run <script>` sempre
  // passa por um shell entre `spawnSync` e o script. No Linux da CI, esse
  // shell converte SIGKILL em `status` 137 (`signal: null`); no macOS o
  // sinal chega direto (`status: null`, `signal: "SIGKILL"`). Sem nenhum
  // `process.platform` aqui: os dois caminhos possíveis convergem para a
  // mesma causa em `evaluateRun` (ver testes dedicados a cada caminho, com
  // subprocesso real, no describe abaixo), e é isso que se prova aqui —
  // qualquer forma bruta que `realExecute` devolva vira o mesmo fault.
  it("morte por sinal do script (direta ou convertida em 128+n pelo shell) vira MUTATION_ALL_KILLED:SIGKILL", () => {
    const dir = fakeProjectDir({
      killself: `${process.execPath} -e "process.kill(process.pid, 'SIGKILL')"`,
    });
    const run = realExecute("killself", { cwd: dir, timeoutMs: 5000 });
    expect(run.error).toBeUndefined();
    expect(() => evaluateRun(run, "ctx")).toThrow(/^MUTATION_ALL_KILLED:ctx:SIGKILL$/);
  });

  it("devolve status != 0 (sem lançar) quando o script imprime relatório limpo e sai 3", () => {
    const dir = fakeProjectDir({
      clean3: `${process.execPath} -e "console.log(JSON.stringify({suite:'x',candidateSha:'d',killed:1,total:1,survivors:[],restoreGreen:true}));process.exit(3)"`,
    });
    const run = realExecute("clean3", { cwd: dir, timeoutMs: 5000 });
    expect(run.status).toBe(3);
    expect(run.signal).toBeNull();
    expect(run.error).toBeUndefined();
    expect(extractJsonLine(run.stdout, "ctx")).toContain('"suite":"x"');
  });
});

/** Um `RunResult` mínimo a partir de um `spawnSync` real — só os quatro
 * campos que `evaluateRun` lê. */
function toRunResult(raw: { status: number | null; signal: NodeJS.Signals | null }): RunResult {
  return { status: raw.status, signal: raw.signal, stdout: "", stderr: "" };
}

// issue #196, rodada 2 (revisão da PR #200): os dois caminhos possíveis de
// morte por sinal, cada um reproduzido com subprocesso real e sem nenhum
// `process.platform` — o comportamento de cada construção (com ou sem shell
// no meio) é determinístico em qualquer POSIX, então os dois testes passam
// tanto no Linux da CI quanto no macOS de desenvolvimento.
describe("evaluateRun (sinal de subprocesso real)", () => {
  it("sinal direto, sem intermediário: spawnSync devolve status null, signal SIGKILL", () => {
    const raw = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], {
      timeout: 5000,
    });
    expect(raw.status).toBeNull();
    expect(raw.signal).toBe("SIGKILL");
    expect(() => evaluateRun(toRunResult(raw), "ctx")).toThrow(/^MUTATION_ALL_KILLED:ctx:SIGKILL$/);
  });

  it("sinal convertido em 128+n pelo shell intermediário (sh -c): status 137, signal null", () => {
    // `; exit $?` força o `sh` a aguardar o filho (em vez de substituir o
    // próprio processo por ele) e a propagar o `$?` observado — no POSIX,
    // um filho morto pelo sinal N sai com status 128+N.
    const raw = spawnSync(
      "sh",
      ["-c", `${process.execPath} -e "process.kill(process.pid, 'SIGKILL')"; exit $?`],
      { timeout: 5000 },
    );
    expect(raw.status).toBe(137);
    expect(raw.signal).toBeNull();
    expect(() => evaluateRun(toRunResult(raw), "ctx")).toThrow(/^MUTATION_ALL_KILLED:ctx:SIGKILL$/);
  });

  it("SIGTERM convertido em 128+n pelo shell intermediário: status 143, signal null", () => {
    const raw = spawnSync(
      "sh",
      ["-c", `${process.execPath} -e "process.kill(process.pid, 'SIGTERM')"; exit $?`],
      { timeout: 5000 },
    );
    expect(raw.status).toBe(143);
    expect(raw.signal).toBeNull();
    expect(() => evaluateRun(toRunResult(raw), "ctx")).toThrow(/^MUTATION_ALL_KILLED:ctx:SIGTERM$/);
  });
});

// issue #196, achado 3: o bloco de entrypoint (`catch` → `process.exitCode =
// 1`) também não tinha teste. Roda `npm run mutations:all` de verdade, num
// subprocesso, apontado (via `MUTATIONS_ALL_SLICES_PATH`) para um
// `slices.json` falso — nunca o `scripts/mutations/slices.json` real, nem
// `package.json` do repo.
describe("entrypoint (subprocesso real, mutations:all)", () => {
  it("sai 1 nomeando a fatia quando o script da fatia falsa não existe", () => {
    const dir = workdir();
    const slicesPath = join(dir, "slices.json");
    writeFileSync(
      slicesPath,
      JSON.stringify([{ slice: "fatia-fake", script: "mutations-all-diag-nao-existe" }]),
      "utf8",
    );
    const result = spawnSync("npm", ["run", "mutations:all"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, MUTATIONS_ALL_SLICES_PATH: slicesPath },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/fatia-fake/);
  }, 90_000);
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
