// Issue #166 (épico #8): `tests/` não pode mais importar/citar o diretório
// histórico de paridade (ver NEEDLE abaixo) — #167 apaga esse diretório.
// AC1: só os testes de classe A (o próprio harness de paridade, sujeito =
// um módulo que fica lá até #167) podem seguir citando o caminho; todo o
// resto tem que estar limpo, inclusive helpers não-`.test.ts`
// (`tests/helpers/**`) e o conteúdo migrado para `tests/support/**` e
// `tests/fixtures/**`.
//
// A whitelist abaixo é a classe A inteira, hoje: cada um desses arquivos
// continua importando, do diretório histórico, um módulo que NÃO se move
// nesta issue (o sujeito do teste é o próprio harness ou, no caso do stub e
// do t22-closeout, um módulo com um segundo consumidor fora do escopo desta
// PR -- `scripts/pack-check.ts`/scripts que ficam -- que impede a
// migração), e será apagado junto com o diretório em #167. Tabela
// módulo -> decisão no corpo da PR #166.
//
// `tests/fixtures/**` fica fora desta varredura: os manifestos JSON
// migrados (`scenarios/*.json`, `manifests/t15,t20/**`) são dados puros --
// `scenarios.test.ts` só confere a FORMA deles (ids, comparisons,
// preconditions via `parseScenarioManifest`), nunca spawna o script que um
// campo `prefixArgs` nomeia. Vários desses campos apontam, de propósito,
// para o lado oráculo/candidato do harness antigo (`oracle_driver.py`,
// `event-fixture.mjs`, etc.) que NENHUM teste executa -- só o runner real
// (`npm run parity:*`) o faria, e esse runner é classe A: fica no diretório
// histórico até #167 apagar tudo de uma vez, dado e script juntos.
// Reescrever esses literais aqui seria dado morto sem consumidor.
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

const CLASSE_A_ALLOWLIST: readonly string[] = [
  "tests/parity/bounds.test.ts",
  "tests/parity/capture.test.ts",
  "tests/parity/cli.test.ts",
  "tests/parity/guard.test.ts",
  "tests/parity/harness.test.ts",
  "tests/parity/preconditions.test.ts",
  "tests/parity/process.test.ts",
  "tests/parity/scrub.test.ts",
  "tests/parity/stub-driver.test.ts",
  "tests/parity/stub-lane-script.test.ts",
  "tests/t22-closeout.test.ts",
];

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
    // e o que esta issue migra para support/); um número muito menor indica
    // que o glob parou de descer em algum subdiretório.
    expect(files.length).toBeGreaterThan(150);
  });

  it(`nenhum arquivo de código fora da classe A cita ${NEEDLE}`, () => {
    // tests/fixtures/** é dado puro, coberto pelo comentário do arquivo
    // (campos como prefixArgs nomeiam scripts do harness antigo que ficam
    // classe A -- nenhum teste os executa).
    const offenders = files
      .filter((relPath) => !relPath.startsWith("tests/fixtures/"))
      .filter((relPath) => !CLASSE_A_ALLOWLIST.includes(relPath))
      .filter((relPath) => readFileSync(resolve(testsRoot, "..", relPath), "utf8").includes(NEEDLE))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("a whitelist da classe A não tem entrada morta (todas existem e citam o caminho)", () => {
    for (const relPath of CLASSE_A_ALLOWLIST) {
      const full = resolve(testsRoot, "..", relPath);
      expect(files, relPath).toContain(relPath);
      expect(readFileSync(full, "utf8"), relPath).toContain(NEEDLE);
    }
  });

  it("a whitelist está ordenada e sem duplicatas", () => {
    expect(CLASSE_A_ALLOWLIST).toEqual([...CLASSE_A_ALLOWLIST].sort());
    expect(new Set(CLASSE_A_ALLOWLIST).size).toBe(CLASSE_A_ALLOWLIST.length);
  });
});

// A varredura acima (grep de citações em tests/) passa por construção no
// overlay do check `controle-negativo`: o overlay do CI aplica o diff
// inteiro de tests/**+prova/** sobre a base, e como tests/support/** e
// tests/fixtures/** (o destino da migração) vão junto no overlay, o
// diretório histórico continua intacto tanto na base quanto em
// base+overlay -- nenhuma citação em tests/ muda de "presente" para
// "ausente" só com o overlay, então a varredura acima nunca discrimina
// vermelho de verde por si só. Como o diff desta PR também toca o
// diretório histórico (não cabe inteiro em tests/**/prova/**), a exceção
// de "tests/** inteiramente novo" (issue #117) não se aplica.
//
// Esta segunda descrição fecha essa lacuna: prende o que SAIU do diretório
// histórico (a metade do `git mv` que o overlay não reproduz, porque ele
// não está em tests/**/prova/**). Em base+overlay esses arquivos ainda
// existem lá -- a asserção abaixo reprova; no HEAD de verdade, saíram --
// passa. Lista extraída da tabela módulo -> decisão do corpo da PR #166.
describe(`classe B saiu de fato de ${NEEDLE}/`, () => {
  // Movidos sem deixar rastro (git mv puro, nenhum consumidor restante no
  // diretório histórico).
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

  it(`nenhum dos módulos migrados sem shim continua em ${NEEDLE}/`, () => {
    const sobreviventes = REMOVIDOS_SEM_SHIM.filter((relPath) =>
      existsSync(join(ROOT, "scripts", "parity", relPath)),
    );
    expect(sobreviventes).toEqual([]);
  });

  // Exceção declarada (corpo da PR #166, "Decisão de arquitetura"):
  // run-joint-gate.ts e run-scenarios.ts já passavam de 800 linhas na base;
  // apontar seus imports para o caminho novo, mais longo, os empurraria
  // para além do limite de arquivo-grande. Estes três nomes continuam no
  // diretório histórico (gateway/), mas só como reexport de uma linha --
  // pinado aqui como shim, não como implementação real, para que
  // reintroduzir lógica ali (em vez de em tests/support/) quebre este
  // teste também.
  const SHIMS_DE_REEXPORT: ReadonlyMap<string, string> = new Map([
    [
      "gateway/launch-candidate-fake.ts",
      'export * from "../../../tests/support/parity/gateway/launch-candidate-fake.js";',
    ],
    [
      "gateway/raw-http-client.ts",
      'export * from "../../../tests/support/parity/gateway/raw-http-client.js";',
    ],
    [
      "gateway/raw-ws-client.ts",
      'export * from "../../../tests/support/parity/gateway/raw-ws-client.js";',
    ],
  ]);

  it("os três shims de gateway existem e são só um reexport de uma linha", () => {
    for (const [relPath, exportLine] of SHIMS_DE_REEXPORT) {
      const full = join(ROOT, "scripts", "parity", relPath);
      expect(existsSync(full), relPath).toBe(true);
      const source = readFileSync(full, "utf8");
      const codeLines = source.split("\n").filter((line) => !line.trimStart().startsWith("//"));
      const nonEmptyCodeLines = codeLines.filter((line) => line.trim() !== "");
      expect(nonEmptyCodeLines, relPath).toEqual([exportLine]);
    }
  });

  // Fixtures lidas por tests/parity/scenarios.test.ts: 39 cenários, o
  // manifesto de t15 e os 25 de t20 -- movidos por inteiro para
  // tests/fixtures/parity/, nenhum ficou para trás.
  const SCENARIOS_MOVIDOS: readonly string[] = [
    "deliberate-divergence",
    "events-jsonl-fixture",
    "normalization-replace-json-pointer",
    "normalization-replace-text",
    "oracle-no-subcommand",
    "oracle-version",
    "oracle-workflow-list",
    "serializer-json-stringify-divergence",
    "t02-chat-auto-down",
    "t02-chat-auto-empty-models",
    "t02-chat-auto-json",
    "t02-chat-explicit-down",
    "t02-chat-http-401",
    "t02-chat-http-500",
    "t02-chat-json-no-tools",
    "t02-chat-provider-without-model-up",
    "t02-chat-stream",
    "t02-chat-stream-nodone",
    "t02-chat-stream-options-retry",
    "t02-chat-tool-read-file-json",
    "t02-chat-tool-read-file-stream",
    "t02-chat-tool-unknown",
    "t02-deliberate-divergence",
    "t02-doctor-down",
    "t02-doctor-empty-models",
    "t02-doctor-up",
    "ts-doctor-down",
    "ts-doctor-env-file",
    "ts-doctor-env-profile",
    "ts-doctor-env-sources",
    "ts-doctor-home-override",
    "ts-doctor-invalid-order",
    "ts-doctor-invalid-profile",
    "ts-doctor-profile",
    "ts-doctor-text-down",
    "ts-doctor-unicode-profile",
    "ts-help",
    "ts-no-subcommand",
    "ts-version",
  ];

  it("declara os 39 cenários migrados (regressão da lista)", () => {
    expect(SCENARIOS_MOVIDOS.length).toBe(39);
    expect(new Set(SCENARIOS_MOVIDOS).size).toBe(SCENARIOS_MOVIDOS.length);
  });

  it(`nenhum dos 39 cenários migrados continua em ${NEEDLE}/scenarios/`, () => {
    const sobreviventes = SCENARIOS_MOVIDOS.filter((name) =>
      existsSync(join(ROOT, "scripts", "parity", "scenarios", `${name}.json`)),
    );
    expect(sobreviventes).toEqual([]);
  });

  it(`manifests/t15 e manifests/t20 saíram por inteiro de ${NEEDLE}/manifests/`, () => {
    expect(existsSync(join(ROOT, "scripts", "parity", "manifests", "t15"))).toBe(false);
    expect(existsSync(join(ROOT, "scripts", "parity", "manifests", "t20"))).toBe(false);
  });

  it("os mesmos módulos e fixtures existem no destino migrado", () => {
    for (const relPath of REMOVIDOS_SEM_SHIM) {
      expect(existsSync(join(ROOT, "tests", "support", "parity", relPath)), relPath).toBe(true);
    }
    for (const relPath of SHIMS_DE_REEXPORT.keys()) {
      expect(existsSync(join(ROOT, "tests", "support", "parity", relPath)), relPath).toBe(true);
    }
    for (const name of SCENARIOS_MOVIDOS) {
      const dest = join(ROOT, "tests", "fixtures", "parity", "scenarios", `${name}.json`);
      expect(existsSync(dest), name).toBe(true);
    }
    expect(existsSync(join(ROOT, "tests", "fixtures", "parity", "manifests", "t15"))).toBe(true);
    expect(existsSync(join(ROOT, "tests", "fixtures", "parity", "manifests", "t20"))).toBe(true);
  });
});
