// Issue #186: nenhum runner de `scripts/mutations/` pode disparar `main()`
// só por ser importado — um teste ou ferramenta que importe por engano não
// pode disparar uma corrida de mutação de verdade (minutos, escreve
// `.mutation-evidence/`). O implementador da #154 constatou isso
// empiricamente ao importar `workflow-executor.ts` para contar mutantes.
//
// Prova por subprocesso isolado — nunca in-process: os runners sem guarda
// chamam `main()` incondicionalmente na avaliação do módulo, e um
// `import()` direto aqui dentro do processo do vitest rodaria a mutação de
// verdade (arquivo real, `git archive`, `vitest` em subprocesso). Duas
// peças isolam isso:
//
//   1. um `git` FAKE no `PATH` do subprocesso: qualquer invocação grava um
//      marcador num arquivo e sai com status 1. Se `main()` rodar (guarda
//      ausente ou quebrada), ele falha na primeira chamada de git
//      (`rev-parse HEAD`, sempre a primeira coisa que cada runner faz) —
//      antes de qualquer `git archive`/sandbox/vitest real. Rápido e sem
//      efeito colateral de verdade, mesmo no estado vermelho.
//   2. um script carregador minúsculo que só faz `await import(<runner>)`
//      e relata `{ ok, hasMain }` em JSON — nunca chama nada do runner além
//      do import estático do módulo (nunca invoca `main` diretamente; isso
//      é exatamente o comportamento que a guarda de entry-point
//      (`ehEntryPoint`, molde de `scripts/provenance/check-ancestry.ts`)
//      precisa negar).
//
// Depois do subprocesso terminar, o marcador não pode existir — se existir,
// `main()` rodou (ou tentou rodar) só porque o módulo foi importado.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const tsxLoader = import.meta.resolve("tsx");

const RUNNERS = [
  "scripts/mutations/workflow-executor.ts",
  "scripts/mutations/workflow-durability.ts",
  "scripts/mutations/workflow-audit-live.ts",
  "scripts/mutations/web-tools.ts",
  "scripts/mutations/media.ts",
  "scripts/mutations/self-update.ts",
] as const;

const GIT_SHIM = "#!/bin/sh\nprintf 'invoked\\n' >> \"$GIT_MARKER\"\nexit 1\n";

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    const sandbox = sandboxes.pop();
    if (sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true });
  }
});

interface LoaderResult {
  readonly ok: boolean;
  readonly hasMain?: boolean;
  readonly error?: string;
}

function isLoaderResult(value: unknown): value is LoaderResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

/** Roda um `import()` isolado de `runnerRelPath` num subprocesso com `git`
 * substituído por um fake que grava `marker` e sai 1 (nunca deixa uma
 * chamada real de git prosseguir para `git archive`/vitest). Devolve se o
 * marcador foi escrito (== `main()` rodou) e o que o carregador reportou. */
function importInSandbox(runnerRelPath: string): {
  readonly gitInvoked: boolean;
  readonly loader: LoaderResult;
} {
  const sandbox = mkdtempSync(join(tmpdir(), "lohra-runner-guard-"));
  sandboxes.push(sandbox);

  const shimDir = join(sandbox, "shim");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "git"), GIT_SHIM, { mode: 0o755 });
  const marker = join(sandbox, "git-invoked.marker");

  const runnerAbs = resolve(repoRoot, runnerRelPath);
  const loaderPath = join(sandbox, "loader.mjs");
  writeFileSync(
    loaderPath,
    [
      'import { pathToFileURL } from "node:url";',
      "try {",
      `  const mod = await import(pathToFileURL(${JSON.stringify(runnerAbs)}).href);`,
      '  console.log(JSON.stringify({ ok: true, hasMain: typeof mod.main === "function" }));',
      "} catch (cause) {",
      "  console.log(",
      "    JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }),",
      "  );",
      "}",
      "",
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, ["--import", tsxLoader, loaderPath], {
    cwd: sandbox,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}`, GIT_MARKER: marker },
  });

  expect(
    result.error,
    `${runnerRelPath}: subprocesso falhou ao rodar: ${String(result.error)}`,
  ).toBeUndefined();

  const jsonLine = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .pop();
  expect(
    jsonLine,
    `${runnerRelPath}: carregador não produziu JSON (stderr: ${result.stderr})`,
  ).toBeDefined();
  const parsed: unknown = JSON.parse(jsonLine as string);
  if (!isLoaderResult(parsed))
    throw new Error(`${runnerRelPath}: JSON inesperado: ${String(jsonLine)}`);

  return { gitInvoked: existsSync(marker), loader: parsed };
}

describe("scripts/mutations/*.ts: importar um runner nunca dispara main()", () => {
  for (const runner of RUNNERS) {
    it(`${runner}: import não invoca git (main não roda) e exporta main`, () => {
      const { gitInvoked, loader } = importInSandbox(runner);
      expect(gitInvoked, `${runner}: git foi invocado durante o import — main() rodou`).toBe(false);
      expect(loader.ok, `${runner}: import lançou: ${String(loader.error)}`).toBe(true);
      expect(loader.hasMain, `${runner}: não exporta "main"`).toBe(true);
    });
  }
});
