// Fixtures compartilhadas pela suíte de integração do `controle-negativo`
// (issue #48/#62/#114), extraídas de `tests/ci-controle-negativo-integracao.test.ts`
// para `tests/ci-controle-negativo-lacunas.test.ts` (issue #117, rodada 2 do
// revisor da PR #119 — `arquivo-grande`: 755 → 829 linhas) poder reusar os
// mesmos repositórios git temporários sem duplicar código.
//
// Nenhuma asserção mora aqui — só a construção de repositórios git
// descartáveis e o disparo de `run.ts` via subprocesso. `limparWorkdirs`
// precisa ser chamada em `afterEach` por QUEM IMPORTA este módulo: cada
// arquivo de teste tem sua própria cópia (o vitest isola módulos por
// arquivo por padrão), então cada um só limpa o que criou.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");
export const runScript = resolve(repoRoot, "scripts/ci/controle-negativo/run.ts");
// Issue #137: nunca pelo wrapper CLI do `tsx` (nem via o shim `.bin/tsx`
// da pasta de dependências, que é um symlink pra ele) — o handshake de sinal
// do wrapper (~30ms + 30ms ack, depois SIGKILL) é suspeito de custo e de
// flake sob carga (#128/#131). `--import` com o loader do `tsx` lança um
// único processo real (molde: `scripts/parity/gateway/launch-candidate.ts`,
// issue #132).
export const tsxLoader = import.meta.resolve("tsx");

export const TIMEOUT_TESTE = 60_000;

// O "harness" desses repositórios fake é um script Node standalone que nunca
// toca vitest/tsx: o controle negativo trata `npm run -s prova -- <slug>`
// como caixa-preta, então o fake só precisa produzir um `resumo.json` no
// mesmo formato.
export const PROVA_RUN_CJS = `
const fs = require("fs");
const path = require("path");
const slug = process.argv[2];
const testPath = path.join(__dirname, "tests", slug + ".test.ts");
let resumo;
try {
  const src = fs.readFileSync(testPath, "utf8");
  const mod = { exports: {} };
  new Function("module", "exports", "require", src)(mod, mod.exports, require);
  mod.exports.run();
  resumo = { ok: true, total: 1, falhas: [] };
} catch (err) {
  const nome =
    err && err.code === "MODULE_NOT_FOUND" ? "tests/" + slug + ".test.ts" : "asserção real";
  resumo = { ok: false, total: 1, falhas: [{ nome, motivo: String((err && err.message) || err) }] };
}
const outDir = path.join(__dirname, ".prova", slug);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "resumo.json"), JSON.stringify(resumo, null, 2) + "\\n");
process.stdout.write(JSON.stringify(resumo) + "\\n");
process.exit(resumo.ok ? 0 : 1);
`;

const workdirs: string[] = [];

/** Chame em `afterEach` de cada suíte que importa este módulo. */
export function limparWorkdirs(): void {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

export function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
  }
}

export function gitCapture(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export interface OpcoesRepo {
  readonly packageJsonText?: string;
  readonly provaRunCjs?: string;
}

export function novoRepo(opcoes: OpcoesRepo = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "controle-negativo-"));
  workdirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "prova@example.com"]);
  git(dir, ["config", "user.name", "Prova"]);
  writeFileSync(
    join(dir, "package.json"),
    opcoes.packageJsonText ??
      `${JSON.stringify(
        { name: "fake", version: "0.0.0", scripts: { prova: "node prova-run.cjs" } },
        null,
        2,
      )}\n`,
  );
  writeFileSync(join(dir, "prova-run.cjs"), opcoes.provaRunCjs ?? PROVA_RUN_CJS);
  return dir;
}

export function commitTudo(dir: string, mensagem: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", mensagem]);
  return gitCapture(dir, ["rev-parse", "HEAD"]);
}

export function escreverTeste(
  dir: string,
  slug: string,
  corpo = "module.exports.run = function () {};\n",
): void {
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "prova"), { recursive: true });
  writeFileSync(join(dir, "tests", `${slug}.test.ts`), corpo);
  writeFileSync(join(dir, "prova", `${slug}.ts`), "// declaração de prova (fixture de teste)\n");
}

interface RepoCenario {
  readonly dir: string;
  readonly base: string;
  readonly head: string;
  readonly slug: string;
}

/** Base com uma implementação errada; HEAD acrescenta o teste (que passa a
 * reprovar de verdade contra o bug da base) — cenário `assertion-red`. */
export function repoAssertionRed(): RepoCenario {
  const dir = novoRepo();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "soma.cjs"), "module.exports.somar = (a, b) => a - b;\n");
  const base = commitTudo(dir, "feat: soma inicial (com bug)");

  escreverTeste(
    dir,
    "soma",
    [
      'const { somar } = require("./src/soma.cjs");',
      "module.exports.run = function () {",
      "  const resultado = somar(1, 2);",
      '  if (resultado !== 3) { throw new Error("esperava 3, obteve " + resultado); }',
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "src", "soma.cjs"), "module.exports.somar = (a, b) => a + b;\n");
  const head = commitTudo(dir, "test(red): cobre soma com o bug corrigido");
  return { dir, base, head, slug: "soma" };
}

/** Teste sem asserção nenhuma — passa até contra a base sem implementação. */
export function repoVacuousPass(): RepoCenario {
  const dir = novoRepo();
  const base = commitTudo(dir, "chore: repo vazio");
  escreverTeste(dir, "vazio");
  const head = commitTudo(dir, "test: teste que não afirma nada");
  return { dir, base, head, slug: "vazio" };
}

const TESTE_ESTRUTURAL = [
  'const { somar } = require("./src/estrutural.cjs");',
  "module.exports.run = function () {",
  '  if (somar(1, 2) !== 3) { throw new Error("nunca chega aqui"); }',
  "};",
  "",
].join("\n");

export type VarianteEstrutural =
  | "com-stub"
  | "com-fix-depois"
  | "sem-test-red"
  | "sem-stub"
  | "comentario"
  | "muda-producao-sem-throw";

/**
 * Base sem `src/estrutural.cjs` — o `require` no teste falha com
 * `MODULE_NOT_FOUND` (estrutural). As variantes cobrem a regra de
 * `structural-red` (rodada 2 da PR #54, mais issue #62):
 *   - "com-stub": um único commit `test(red):` que adiciona o teste E um
 *     stub que lança em `src/estrutural.cjs` (arquivo NÃO-teste) — aceito.
 *   - "com-fix-depois": o mesmo `test(red):` com stub, seguido de um
 *     commit comum que só toca o teste de novo — ainda aceito (o gate é
 *     "existe pelo menos um", não "o último").
 *   - "sem-test-red": nenhum commit no range é `test(red):` — reprovado.
 *   - "sem-stub": o commit É `test(red):`, mas não toca nenhum arquivo
 *     não-teste (sem stub declarado) — reprovado.
 *   - "comentario" (issue #62): o commit É `test(red):` e toca
 *     `src/estrutural.cjs`, mas o `throw new Error(` está só num
 *     comentário — reprovado (git show real, não a fixture unitária de
 *     `contemStubQueLanca`).
 *   - "muda-producao-sem-throw" (issue #62): o commit É `test(red):` e
 *     toca `src/estrutural.cjs` com uma mudança real (não-comentário), mas
 *     sem `throw` — reprovado; distingue de "sem-stub" (que nem toca
 *     arquivo não-teste) exercitando o `git show` de verdade.
 */
export function repoStructuralRed(variante: VarianteEstrutural): RepoCenario {
  const dir = novoRepo();
  const base = commitTudo(dir, "chore: repo vazio");
  escreverTeste(dir, "estrutural", TESTE_ESTRUTURAL);

  if (variante === "sem-test-red") {
    const head = commitTudo(dir, "feat: cobre estrutural (sem test(red):)");
    return { dir, base, head, slug: "estrutural" };
  }

  if (variante === "sem-stub") {
    const head = commitTudo(dir, "test(red): cobre estrutural (sem stub de produção)");
    return { dir, base, head, slug: "estrutural" };
  }

  mkdirSync(join(dir, "src"), { recursive: true });

  if (variante === "comentario") {
    writeFileSync(
      join(dir, "src", "estrutural.cjs"),
      '// throw new Error("not implemented: somar");\nmodule.exports.somar = () => 0;\n',
    );
    const head = commitTudo(dir, "test(red): cobre estrutural (stub só em comentário)");
    return { dir, base, head, slug: "estrutural" };
  }

  if (variante === "muda-producao-sem-throw") {
    writeFileSync(join(dir, "src", "estrutural.cjs"), "module.exports.somar = () => 0;\n");
    const head = commitTudo(dir, "test(red): cobre estrutural (implementação errada, sem throw)");
    return { dir, base, head, slug: "estrutural" };
  }

  // "com-stub" / "com-fix-depois": adiciona o stub que lança num arquivo
  // não-teste, no MESMO commit `test(red):`.
  writeFileSync(
    join(dir, "src", "estrutural.cjs"),
    'module.exports.somar = () => { throw new Error("not implemented: somar"); };\n',
  );
  let head = commitTudo(dir, "test(red): cobre estrutural (stub que lança)");

  if (variante === "com-fix-depois") {
    writeFileSync(
      join(dir, "tests", "estrutural.test.ts"),
      `${TESTE_ESTRUTURAL}// comentário adicionado depois do vermelho\n`,
    );
    head = commitTudo(dir, "fix(ci): comentário no teste (não é test(red):)");
  }

  return { dir, base, head, slug: "estrutural" };
}

/**
 * Base com bug em `src/soma.cjs`; HEAD extrai um verificador para
 * `tests/helpers/**` — helper NOVO, teste NOVO que o importa, e a correção
 * do bug em `src/**` no mesmo commit (issue #123). Antes da unificação do
 * overlay (`arquivosDeTeste` passou a usar `ehArquivoDoOverlay`), o helper
 * ficava fora do overlay real e o `require` falhava com `MODULE_NOT_FOUND`
 * na base — degradando o desfecho para `structural-red` em vez do
 * `assertion-red` de verdade (a asserção do helper, contra o bug ainda
 * presente na base).
 */
export function repoAssertionRedComHelperNovo(): RepoCenario {
  const dir = novoRepo();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "soma.cjs"), "module.exports.somar = (a, b) => a - b;\n");
  const base = commitTudo(dir, "feat: soma inicial (com bug)");

  mkdirSync(join(dir, "tests", "helpers"), { recursive: true });
  mkdirSync(join(dir, "prova"), { recursive: true });
  writeFileSync(
    join(dir, "tests", "helpers", "soma-ajuda.cjs"),
    [
      "module.exports.verificarSoma = function (resultado, esperado) {",
      "  if (resultado !== esperado) {",
      '    throw new Error("esperava " + esperado + ", obteve " + resultado);',
      "  }",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tests", "soma-helper.test.ts"),
    [
      'const { somar } = require("./src/soma.cjs");',
      'const { verificarSoma } = require("./tests/helpers/soma-ajuda.cjs");',
      "module.exports.run = function () {",
      "  verificarSoma(somar(1, 2), 3);",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "prova", "soma-helper.ts"),
    "// declaração de prova (fixture de teste)\n",
  );
  writeFileSync(join(dir, "src", "soma.cjs"), "module.exports.somar = (a, b) => a + b;\n");
  const head = commitTudo(dir, "test(red): cobre soma com helper extraído (issue #123)");
  return { dir, base, head, slug: "soma-helper" };
}

function envSemVitest(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("VITEST") && key !== "LOHRA_PROVA_OUT",
    ),
  );
}

export function runControleNegativo(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", tsxLoader, runScript, ...args], {
    encoding: "utf8",
    timeout: TIMEOUT_TESTE,
    env: envSemVitest(),
  });
}

/** Igual a `runControleNegativo`, mas com variáveis extra no ambiente do
 * subprocesso (issue #122) — usado para sobrescrever `TMPDIR`: `run.ts`
 * chama `mkdtempSync(tmpdir(), ...)`, e `os.tmpdir()` do Node lê `TMPDIR`
 * do PRÓPRIO processo a cada chamada, então isso basta para isolar onde o
 * workdir do subprocesso nasce, sem tocar `run.ts`. */
export function runControleNegativoComEnv(
  args: readonly string[],
  envExtra: Record<string, string>,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", tsxLoader, runScript, ...args], {
    encoding: "utf8",
    timeout: TIMEOUT_TESTE,
    env: { ...envSemVitest(), ...envExtra },
  });
}

/** Atalho: roda com `--root`/`--base`/`--head`/`--slug` — os quatro
 * argumentos usados por quase todo teste. */
export function rodar(
  dir: string,
  base: string,
  head: string,
  slug?: string,
): SpawnSyncReturns<string> {
  const args = ["--root", dir, "--base", base, "--head", head];
  if (slug !== undefined) args.push("--slug", slug);
  return runControleNegativo(args);
}

/** Igual a `runControleNegativo`, mas com `GITHUB_STEP_SUMMARY` apontando
 * para um arquivo descartável — para os testes que precisam confirmar o
 * motivo do SKIP no summary do job, não só no stdout (issue #114). */
export function runControleNegativoComSummary(args: readonly string[]): {
  result: SpawnSyncReturns<string>;
  summary: string;
} {
  const summaryPath = join(mkdtempSync(join(tmpdir(), "controle-negativo-summary-")), "summary.md");
  workdirs.push(join(summaryPath, ".."));
  writeFileSync(summaryPath, "");
  const result = spawnSync(process.execPath, ["--import", tsxLoader, runScript, ...args], {
    encoding: "utf8",
    timeout: TIMEOUT_TESTE,
    env: { ...envSemVitest(), GITHUB_STEP_SUMMARY: summaryPath },
  });
  return { result, summary: readFileSync(summaryPath, "utf8") };
}

/** Roda `run.ts` com `PATH` vazio — `git` vira ENOENT (issue #62). */
export function rodarComPathVazio(
  dir: string,
  base: string,
  head: string,
  slug: string,
): SpawnSyncReturns<string> {
  const dirVazio = mkdtempSync(join(tmpdir(), "controle-negativo-path-vazio-"));
  try {
    return spawnSync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        runScript,
        "--root",
        dir,
        "--base",
        base,
        "--head",
        head,
        "--slug",
        slug,
      ],
      { encoding: "utf8", timeout: TIMEOUT_TESTE, env: { ...envSemVitest(), PATH: dirVazio } },
    );
  } finally {
    rmSync(dirVazio, { recursive: true, force: true });
  }
}
