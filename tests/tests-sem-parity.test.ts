// Issue #167 (épico #8): apaga `scripts/parity/` inteiro — a classe A que
// #166 deixou para trás (o próprio harness de paridade, sem nenhum
// consumidor em `tests/` além dele mesmo). Este arquivo nasceu em #166 como
// o pino de que `tests/` não cita mais o diretório histórico fora de uma
// whitelist de classe A; com o diretório inteiro apagado aqui, a whitelist
// fica vazia (não sobra nenhum teste cujo sujeito seja o harness) e ganha um
// pino novo: o diretório em si não existe mais, nem em `package.json` sobra
// um script apontando para ele.
//
// `tests/fixtures/**` fica fora desta varredura: os manifestos JSON
// migrados em #166 (`scenarios/*.json`, `manifests/t15,t20/**`) são dados
// puros — `scenarios.test.ts` só confere a FORMA deles, nunca spawna o
// script que um campo `prefixArgs` nomeia. Vários desses campos apontam,
// de propósito, para o lado oráculo/candidato do harness antigo
// (`oracle_driver.py`, `event-fixture.mjs`, etc.) que nenhum teste executa.
// Reescrever esses literais aqui seria dado morto sem consumidor — e não é
// o que esta issue pede (ver "Fora de escopo").
//
// `tests/mutations-harness.test.ts` PRECISA checar, em runtime, que outros
// arquivos não citam o caminho — mas constrói o literal via `join("/")`
// (mesmo motivo do NEEDLE abaixo: ficar fora do grep) em vez de entrar
// nesta whitelist, porque seu sujeito não é o harness de paridade.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const testsRoot = resolve(import.meta.dirname);
const ROOT = resolve(testsRoot, "..");

// Construído para não conter o literal contíguo -- senão este próprio
// arquivo apareceria no grep que ele mesmo prova estar vazio.
const NEEDLE = ["scripts", "parity"].join("/");

// Classe A do harness (bounds/capture/cli/guard/harness/preconditions/
// process/scrub e os dois testes do stub) saiu com o diretório inteiro:
// os oito primeiros foram apagados (sujeito sumiu) e os dois do stub
// seguiram `scripts/parity/stub/**` para `scripts/stub/` sem precisar mais
// citar o caminho histórico. Nenhum arquivo de `tests/` cita mais o
// diretório — a whitelist fica vazia de propósito (não é um placeholder:
// o teste abaixo prende que ela continua vazia).
const CLASSE_A_ALLOWLIST: readonly string[] = [];

function listAllFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listAllFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function toRepoRelative(file: string): string {
  return relative(resolve(testsRoot, ".."), file).split(sep).join("/");
}

describe(`tests/ sem citações a ${NEEDLE} fora da classe A`, () => {
  const files = listAllFiles(testsRoot).map(toRepoRelative);

  it("a varredura acha os arquivos conhecidos (regressão do glob)", () => {
    // Hoje há mais de 150 arquivos sob tests/ (inclusive helpers/, fixtures/
    // e o que #166 migrou para support/); um número muito menor indica que
    // o glob parou de descer em algum subdiretório.
    expect(files.length).toBeGreaterThan(150);
  });

  it(`nenhum arquivo de código fora da classe A cita ${NEEDLE}`, () => {
    // tests/fixtures/** é dado puro, coberto pelo comentário do arquivo
    // (campos como prefixArgs nomeiam scripts do harness antigo que nenhum
    // teste executa).
    const offenders = files
      .filter((relPath) => !relPath.startsWith("tests/fixtures/"))
      .filter((relPath) => !CLASSE_A_ALLOWLIST.includes(relPath))
      .filter((relPath) => readFileSync(resolve(testsRoot, "..", relPath), "utf8").includes(NEEDLE))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("a whitelist da classe A está vazia (o harness inteiro saiu com o diretório)", () => {
    expect(CLASSE_A_ALLOWLIST).toEqual([]);
  });
});

describe(`${NEEDLE}/ não existe mais`, () => {
  it(`${NEEDLE} saiu do disco por inteiro`, () => {
    expect(existsSync(join(ROOT, "scripts", "parity"))).toBe(false);
  });

  it("os módulos e fixtures migrados por #166 continuam no destino (independente do diretório histórico)", () => {
    // Regressão da migração de #166: apagar o diretório histórico não pode
    // levar junto o que já tinha saído dele por `git mv`.
    const REMOVIDOS_SEM_SHIM: readonly string[] = [
      "auth/socket-sentinel.cjs",
      "canonical.ts",
      "closeout/evidence-validation.ts",
      "closeout/normalization.ts",
      "closeout/verify-evidence.ts",
      "compare.ts",
      "errors.ts",
      "gateway/candidate-dash-launcher.ts",
      "gateway/launch-candidate.ts",
      "manifest.ts",
      "provider-transports/responses-profile.ts",
      "types.ts",
      "workflow-executor/candidate-chat.mjs",
    ];
    const shims: readonly string[] = [
      "gateway/launch-candidate-fake.ts",
      "gateway/raw-http-client.ts",
      "gateway/raw-ws-client.ts",
    ];
    for (const relPath of [...REMOVIDOS_SEM_SHIM, ...shims]) {
      expect(existsSync(join(ROOT, "tests", "support", "parity", relPath)), relPath).toBe(true);
    }
    expect(existsSync(join(ROOT, "tests", "fixtures", "parity", "manifests", "t15"))).toBe(true);
    expect(existsSync(join(ROOT, "tests", "fixtures", "parity", "manifests", "t20"))).toBe(true);
  });

  it("o stub segue em scripts/stub/, fora do diretório histórico apagado", () => {
    for (const name of ["driver.ts", "server.ts", "types.ts"]) {
      expect(existsSync(join(ROOT, "scripts", "stub", name)), name).toBe(true);
    }
    expect(existsSync(join(ROOT, "scripts", "stub", "python-sitecustomize"))).toBe(false);
  });
});

describe("package.json sem script apontando para o diretório histórico", () => {
  it(`nenhum valor de "scripts" em package.json cita ${NEEDLE}`, () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const offenders = Object.entries(manifest.scripts ?? {})
      .filter(([, command]) => command.includes(NEEDLE))
      .map(([name]) => name)
      .sort();
    expect(offenders).toEqual([]);
  });
});
