#!/usr/bin/env node
// Issue #576: `npm run eval [-- --provider <p>] [--set dev|holdout|all]
// [--cli <path>]` — o CLI do harness. Sem `--provider`, roda contra o stub
// local (nunca faz rede) e é o oráculo de mecanismo que
// `tests/eval-cases.test.ts` também roda em `npm test`. Com `--provider
// <p>`, roda contra um provedor real — e nunca em CI (`refuseNetworkInCi`),
// sempre gravando em `docs/eval/<data>-<provedor|stub>/`.
//
// Rodada 1b: por padrão, o CLI é invocado **in-process** via `runCli`
// (`scripts/eval/session.ts`) — não depende de `dist/`, porque `npm test`
// roda ANTES de `npm run build` no CI (`tests/ci-workflow-order.test.ts`).
// `--cli <path>` (ex.: `--cli dist/cli.js`, depois de `npm run build`) troca
// para um subprocesso de verdade contra esse caminho — o modo do operador
// para validar o pacote empacotado, nunca o caminho que os testes exercitam.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { parseEvalCase } from "./case.js";
import { refuseNetworkInCi } from "./ci-guard.js";
import { runCaseSafely } from "./runner.js";
import { appendResultLine, buildSummary, resetResultsFile, writeSummary } from "./results.js";
import { runEvalCase, type EvalRunOptions } from "./session.js";
import type { EvalCase, EvalResultLine } from "./types.js";

export { refuseNetworkInCi } from "./ci-guard.js";

export const FIXTURES_DIR = "tests/fixtures/eval";

export interface EvalSplit {
  readonly dev: readonly string[];
  readonly holdout: readonly string[];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Carrega e valida minimamente `split.json` (arrays de string) — a
 * disciplina completa (tamanho mínimo, disjunção, cobertura dos fixtures em
 * disco) é responsabilidade de `tests/eval-cases.test.ts`, não deste CLI. */
export function loadSplit(root: string): EvalSplit {
  const path = resolve(root, FIXTURES_DIR, "split.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`eval: ${path} não é um objeto JSON`);
  }
  const { dev, holdout } = raw as { dev?: unknown; holdout?: unknown };
  if (!isStringArray(dev) || !isStringArray(holdout)) {
    throw new Error(`eval: ${path} precisa de "dev" e "holdout" como string[]`);
  }
  return { dev, holdout };
}

export function loadCase(root: string, id: string): EvalCase {
  const path = resolve(root, FIXTURES_DIR, `${id}.json`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseEvalCase(raw, path, id);
}

export function loadCases(root: string, ids: readonly string[]): readonly EvalCase[] {
  return ids.map((id) => loadCase(root, id));
}

export type EvalCaseSet = "dev" | "holdout" | "all";

export interface ParsedArgs {
  readonly provider?: string;
  readonly set: EvalCaseSet;
  /** `--cli <path>`: opcional, subprocesso de verdade contra um CLI
   * empacotado (ex.: `dist/cli.js`). Ausente == in-process (padrão, o modo
   * que `npm test` também exercita, sem depender de `dist/`). */
  readonly cli?: string;
  /** `--tag <t>`: sufixo no diretório de saída (`docs/eval/<data>-<label>-<t>/`)
   * — sem ele, duas corridas no mesmo dia (ex.: antes/depois de uma mudança
   * de prompt) truncam a MESMA `results.jsonl` (`resetResultsFile`) e a
   * comparação por SHA (`docs/eval.md`) fica impossível. */
  readonly tag?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let provider: string | undefined;
  let set: EvalCaseSet = "all";
  let cli: string | undefined;
  let tag: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--provider") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("eval: --provider precisa de um valor");
      provider = value;
      index += 1;
    } else if (flag === "--set") {
      const value = argv[index + 1];
      if (value !== "dev" && value !== "holdout" && value !== "all") {
        throw new Error(`eval: --set precisa ser dev|holdout|all, recebido ${String(value)}`);
      }
      set = value;
      index += 1;
    } else if (flag === "--cli") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("eval: --cli precisa de um caminho");
      cli = value;
      index += 1;
    } else if (flag === "--tag") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("eval: --tag precisa de um valor");
      tag = value;
      index += 1;
    }
  }
  return {
    set,
    ...(provider === undefined ? {} : { provider }),
    ...(cli === undefined ? {} : { cli }),
    ...(tag === undefined ? {} : { tag }),
  };
}

export interface BatchOptions extends EvalRunOptions {
  readonly resultsPath: string;
}

/** Roda os casos em sequência, anexando uma linha por caso assim que ela
 * fica pronta — a AC "um crash não perde o que já rodou" é esta função:
 * `resetResultsFile` só trunca UMA vez, antes do laço, e cada iteração
 * grava a própria linha antes de seguir para a próxima. `runCaseSafely`
 * garante que uma sessão que lança não interrompe o laço. */
export async function runBatch(
  cases: readonly EvalCase[],
  options: BatchOptions,
  runSession: typeof runEvalCase = runEvalCase,
): Promise<readonly EvalResultLine[]> {
  resetResultsFile(options.resultsPath);
  const lines: EvalResultLine[] = [];
  for (const kase of cases) {
    const line = await runCaseSafely(kase, options, runSession);
    appendResultLine(options.resultsPath, line);
    lines.push(line);
  }
  return lines;
}

function idsFor(split: EvalSplit, set: EvalCaseSet): readonly string[] {
  if (set === "dev") return split.dev;
  if (set === "holdout") return split.holdout;
  return [...split.dev, ...split.holdout];
}

/** Issue #607 item 6: sem `--tag`, duas corridas no mesmo dia contra o
 * mesmo alvo produziam o MESMO nome de diretório que um baseline commitado
 * manualmente naquele dia (`docs/eval/<data>-<label>/`) — `npm run eval`
 * sem flags no dia de um baseline SOBRESCREVIA `results.jsonl`/`summary.json`
 * tracked (só `generatedAt`/`elapsedMs` mudam, mas o diff é real). Sem
 * `--tag`, a corrida agora grava em `.eval/` (gitignorado, fora do
 * controle de versão) — nunca em `docs/eval/`, que fica reservado para uma
 * corrida que o operador decidiu explicitamente promover a baseline
 * (`--tag` torna o nome do diretório distinto de qualquer baseline sem
 * tag). Commitar um baseline continua um ato explícito: mover o resultado
 * de `.eval/` para `docs/eval/` é responsabilidade de quem decide isso, não
 * do runner. */
export function resolveOutDir(root: string, args: Pick<ParsedArgs, "provider" | "tag">): string {
  const label = args.provider ?? "stub";
  const date = new Date().toISOString().slice(0, 10);
  const dirName = args.tag === undefined ? `${date}-${label}` : `${date}-${label}-${args.tag}`;
  const base = args.tag === undefined ? ".eval" : "docs/eval";
  return resolve(root, base, dirName);
}

async function main(): Promise<void> {
  const root = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  refuseNetworkInCi(args.provider, process.env);

  let cliPath: string | undefined;
  if (args.cli !== undefined) {
    cliPath = resolve(root, args.cli);
    if (!existsSync(cliPath)) {
      throw new Error(`eval: ${cliPath} não existe (--cli) — rode "npm run build" antes`);
    }
  }

  const split = loadSplit(root);
  const cases = loadCases(root, idsFor(split, args.set));
  const outDir = resolveOutDir(root, args);
  const resultsPath = join(outDir, "results.jsonl");
  const summaryPath = join(outDir, "summary.json");

  const lines = await runBatch(cases, {
    timeoutMs: 20_000,
    resultsPath,
    ...(cliPath === undefined ? {} : { cliPath }),
    ...(args.provider === undefined ? {} : { provider: args.provider }),
  });
  const summary = buildSummary(
    args.provider === undefined ? "stub" : "provider",
    args.provider,
    lines,
  );
  writeSummary(summaryPath, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  // `=== false`, nunca `!line.mechanismOk`: `"skipped"` (modo provider) é
  // falsy-looking em prosa mas não é uma falha de mecanismo — é a ausência
  // honesta de uma avaliação que nunca rodou.
  const failedMechanism = lines.filter((line) => line.mechanismOk === false);
  if (failedMechanism.length > 0) {
    process.stderr.write(
      `eval: ${String(failedMechanism.length)} caso(s) falharam o oráculo de mecanismo: ${failedMechanism
        .map((line) => line.id)
        .join(", ")}\n`,
    );
    process.exitCode = 1;
  }
}

function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invoked)).href;
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(`eval: erro inesperado: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
