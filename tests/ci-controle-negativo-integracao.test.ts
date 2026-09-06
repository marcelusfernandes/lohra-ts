// Integração de ponta a ponta do `controle-negativo` (issue #48), em
// repositórios git temporários e descartáveis — via subprocesso (`run.ts`).
// Extraído de `tests/ci-controle-negativo.test.ts` (issue #62, divisão do
// arquivo de 862 linhas — AC "arquivos < 800 linhas"); os testes puros e
// unitários (com git injetado) ficaram lá.
//
// O "harness" desses repositórios fake é um script Node standalone
// (`prova-run.cjs`) que nunca toca vitest/tsx: o controle negativo trata
// `npm run -s prova -- <slug>` como caixa-preta, então o fake só precisa
// produzir um `resumo.json` no mesmo formato.
//
// Timeout explícito (60s) em todo teste que spawna `tsx` + `git worktree` +
// um `npm run prova` aninhado — o default do vitest (5s) já estourou uma vez
// nesta suíte rodando em paralelo com outra suíte na mesma máquina.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const runScript = resolve(repoRoot, "scripts/ci/controle-negativo/run.ts");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
const tsxCliMjs = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");

const TIMEOUT_TESTE = 60_000;

const PROVA_RUN_CJS = `
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

afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
  }
}

function gitCapture(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
  }
  return result.stdout.trim();
}

interface OpcoesRepo {
  readonly packageJsonText?: string;
  readonly provaRunCjs?: string;
}

function novoRepo(opcoes: OpcoesRepo = {}): string {
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

function commitTudo(dir: string, mensagem: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", mensagem]);
  return gitCapture(dir, ["rev-parse", "HEAD"]);
}

function escreverTeste(
  dir: string,
  slug: string,
  corpo = "module.exports.run = function () {};\n",
): void {
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "prova"), { recursive: true });
  writeFileSync(join(dir, "tests", `${slug}.test.ts`), corpo);
  writeFileSync(join(dir, "prova", `${slug}.ts`), "// declaração de prova (fixture de teste)\n");
}

/** Base com uma implementação errada; HEAD acrescenta o teste (que passa a
 * reprovar de verdade contra o bug da base) — cenário `assertion-red`. */
function repoAssertionRed(): { dir: string; base: string; head: string; slug: string } {
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
function repoVacuousPass(): { dir: string; base: string; head: string; slug: string } {
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

type VarianteEstrutural =
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
function repoStructuralRed(variante: VarianteEstrutural): {
  dir: string;
  base: string;
  head: string;
  slug: string;
} {
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

function runControleNegativo(args: readonly string[]): SpawnSyncReturns<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("VITEST") && key !== "LOHRA_PROVA_OUT",
    ),
  );
  return spawnSync(tsxBin, [runScript, ...args], { encoding: "utf8", timeout: 60_000, env });
}

/** Atalho: roda com `--root`/`--base`/`--head`/`--slug` — os quatro
 * argumentos usados por quase todo teste abaixo. */
function rodar(dir: string, base: string, head: string, slug?: string): SpawnSyncReturns<string> {
  const args = ["--root", dir, "--base", base, "--head", head];
  if (slug !== undefined) args.push("--slug", slug);
  return runControleNegativo(args);
}

/** Igual a `runControleNegativo`, mas com `GITHUB_STEP_SUMMARY` apontando
 * para um arquivo descartável — para os testes que precisam confirmar o
 * motivo do SKIP no summary do job, não só no stdout (issue #114). */
function runControleNegativoComSummary(args: readonly string[]): {
  result: SpawnSyncReturns<string>;
  summary: string;
} {
  const summaryPath = join(mkdtempSync(join(tmpdir(), "controle-negativo-summary-")), "summary.md");
  workdirs.push(join(summaryPath, ".."));
  writeFileSync(summaryPath, "");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("VITEST") && key !== "LOHRA_PROVA_OUT",
    ),
  );
  const result = spawnSync(tsxBin, [runScript, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...env, GITHUB_STEP_SUMMARY: summaryPath },
  });
  return { result, summary: readFileSync(summaryPath, "utf8") };
}

/** Roda `run.ts` com `PATH` vazio — `git` vira ENOENT (issue #62). */
function rodarComPathVazio(dir: string, base: string, head: string, slug: string) {
  const dirVazio = mkdtempSync(join(tmpdir(), "controle-negativo-path-vazio-"));
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("VITEST") && key !== "LOHRA_PROVA_OUT",
      ),
    );
    return spawnSync(
      process.execPath,
      [tsxCliMjs, runScript, "--root", dir, "--base", base, "--head", head, "--slug", slug],
      { encoding: "utf8", timeout: 60_000, env: { ...env, PATH: dirVazio } },
    );
  } finally {
    rmSync(dirVazio, { recursive: true, force: true });
  }
}

describe("controle-negativo/run.ts (subprocesso, repositório git descartável)", () => {
  it(
    "assertion-red: exit 0, e o worktree temporário é removido",
    () => {
      const { dir, base, head, slug } = repoAssertionRed();
      const before = gitCapture(dir, ["worktree", "list", "--porcelain"]);

      const result = rodar(dir, base, head, slug);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("assertion-red");
      expect(gitCapture(dir, ["worktree", "list", "--porcelain"])).toBe(before);
    },
    TIMEOUT_TESTE,
  );

  it(
    "vacuous-pass: exit 1, e o worktree temporário é removido mesmo reprovando",
    () => {
      const { dir, base, head, slug } = repoVacuousPass();
      const before = gitCapture(dir, ["worktree", "list", "--porcelain"]);

      const result = rodar(dir, base, head, slug);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("vacuous-pass");
      expect(gitCapture(dir, ["worktree", "list", "--porcelain"])).toBe(before);
    },
    TIMEOUT_TESTE,
  );

  it(
    "structural-red aceito: um único commit test(red): com stub que lança",
    () => {
      const { dir, base, head, slug } = repoStructuralRed("com-stub");
      const result = rodar(dir, base, head, slug);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("structural-red");
    },
    TIMEOUT_TESTE,
  );

  it(
    "structural-red aceito: test(red): com stub seguido de um commit de fix comum",
    () => {
      const { dir, base, head, slug } = repoStructuralRed("com-fix-depois");
      const result = rodar(dir, base, head, slug);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("structural-red");
    },
    TIMEOUT_TESTE,
  );

  it(
    "structural-red reprovado: nenhum commit test(red): no range",
    () => {
      const { dir, base, head, slug } = repoStructuralRed("sem-test-red");
      const result = rodar(dir, base, head, slug);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("estrutural sem test(red) válido");
    },
    TIMEOUT_TESTE,
  );

  it(
    "structural-red reprovado: test(red): existe mas não adiciona stub que lança",
    () => {
      const { dir, base, head, slug } = repoStructuralRed("sem-stub");
      const result = rodar(dir, base, head, slug);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("estrutural sem test(red) válido");
    },
    TIMEOUT_TESTE,
  );

  it(
    "structural-red reprovado: stub só em comentário, num commit test(red): real (issue #62)",
    () => {
      const { dir, base, head, slug } = repoStructuralRed("comentario");
      const result = rodar(dir, base, head, slug);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("estrutural sem test(red) válido");
    },
    TIMEOUT_TESTE,
  );

  it(
    "structural-red reprovado: test(red): muda produção mas sem throw (issue #62)",
    () => {
      const { dir, base, head, slug } = repoStructuralRed("muda-producao-sem-throw");
      const result = rodar(dir, base, head, slug);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("estrutural sem test(red) válido");
    },
    TIMEOUT_TESTE,
  );

  it(
    "SKIP quando todo o diff é classe docs/process, mesmo sem prova/<slug>.ts",
    () => {
      const dir = novoRepo();
      const base = commitTudo(dir, "chore: init");
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs", "nota.md"), "# nota\n");
      const head = commitTudo(dir, "docs: adiciona nota");

      const result = runControleNegativo(["--root", dir, "--base", base, "--head", head]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SKIP");
    },
    TIMEOUT_TESTE,
  );

  it(
    "SKIP quando o diff é docs/process + scripts/github/** (acréscimo à #62, bloqueava a #65)",
    () => {
      const dir = novoRepo();
      mkdirSync(join(dir, "scripts", "github"), { recursive: true });
      writeFileSync(join(dir, "scripts", "github", "ruleset.sh"), "#!/bin/sh\necho velho\n");
      const base = commitTudo(dir, "chore: ruleset inicial");

      mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
      writeFileSync(join(dir, ".claude", "hooks", "README.md"), "# hooks\n");
      writeFileSync(join(dir, "scripts", "github", "ruleset.sh"), "#!/bin/sh\necho novo\n");
      const head = commitTudo(dir, "ci: ajusta ruleset e README dos hooks");

      const result = runControleNegativo(["--root", dir, "--base", base, "--head", head]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SKIP");
    },
    TIMEOUT_TESTE,
  );

  it(
    "SKIP quando só uma declaração de prova JÁ EXISTENTE na base foi editada, junto de docs/process (acréscimo à #62)",
    () => {
      const dir = novoRepo();
      mkdirSync(join(dir, "prova"), { recursive: true });
      writeFileSync(join(dir, "prova", "convencoes-processo.ts"), "export default { unit: [] };\n");
      const base = commitTudo(dir, "chore: declaração de prova inicial");

      writeFileSync(join(dir, "CLAUDE.md"), "# convenções atualizadas\n");
      writeFileSync(
        join(dir, "prova", "convencoes-processo.ts"),
        'export default { unit: ["tests/x.test.ts"] };\n',
      );
      const head = commitTudo(dir, "docs: atualiza CLAUDE.md e a prova declarada");

      const result = runControleNegativo(["--root", dir, "--base", base, "--head", head]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("declaração de prova existente");
    },
    TIMEOUT_TESTE,
  );

  it(
    "NÃO faz SKIP quando a declaração de prova é NOVA (ausente na base) — continua exigindo controle",
    () => {
      const dir = novoRepo();
      const base = commitTudo(dir, "chore: repo vazio");

      writeFileSync(join(dir, "CLAUDE.md"), "# nota\n");
      mkdirSync(join(dir, "prova"), { recursive: true });
      writeFileSync(join(dir, "prova", "nova-feature.ts"), "export default { unit: [] };\n");
      const head = commitTudo(dir, "feat: declara prova de nova-feature (sem testes ainda)");

      const result = runControleNegativo(["--root", dir, "--base", base, "--head", head]);

      // Sem `prova/nova-feature.ts` na base para ser considerada "já
      // existente", o fluxo normal continua: sem --slug explícito e sem
      // branch reconhecível, `resolverSlug` reprova pedindo --slug/--branch
      // — nunca um SKIP silencioso para uma declaração nova.
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("SKIP");
    },
    TIMEOUT_TESTE,
  );

  it(
    "exit 1 citando o caminho quando prova/<slug>.ts não existe no HEAD (fora do SKIP)",
    () => {
      const dir = novoRepo();
      const base = commitTudo(dir, "chore: init");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "algo.cjs"), "module.exports.algo = () => 1;\n");
      const head = commitTudo(dir, "feat: adiciona algo (sem prova)");

      const result = rodar(dir, base, head, "inexistente");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("prova/inexistente.ts");
    },
    TIMEOUT_TESTE,
  );

  it(
    "--branch resolve o slug quando o HEAD está detached (checkout de CI)",
    () => {
      const { dir, base, head, slug } = repoAssertionRed();
      git(dir, ["checkout", "--detach", head]);

      const result = runControleNegativo([
        "--root",
        dir,
        "--base",
        base,
        "--head",
        head,
        "--branch",
        `feat/999-${slug}`,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("assertion-red");
    },
    TIMEOUT_TESTE,
  );

  it(
    "PASS logado quando a base não declara scripts.prova (harness ainda não existia)",
    () => {
      const dir = novoRepo({ packageJsonText: `${JSON.stringify({ name: "sem-harness" })}\n` });
      const base = commitTudo(dir, "chore: repo antes do harness #42");
      escreverTeste(dir, "algo");
      const head = commitTudo(dir, "test(red): cobre algo");

      const result = rodar(dir, base, head, "algo");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("sem harness na base");
    },
    TIMEOUT_TESTE,
  );

  it(
    "exit 1 quando o package.json da base é JSON inválido (ilegível, não 'sem harness')",
    () => {
      const dir = novoRepo({ packageJsonText: "{ isso não é json" });
      const base = commitTudo(dir, "chore: package.json corrompido");
      escreverTeste(dir, "z");
      const head = commitTudo(dir, "test(red): cobre z");

      const result = rodar(dir, base, head, "z");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("package.json");
      expect(result.stderr).not.toContain("sem harness");
    },
    TIMEOUT_TESTE,
  );

  it(
    "exit 1 citando o caminho quando resumo.json da base tem shape inválido",
    () => {
      const dir = novoRepo({
        packageJsonText: `${JSON.stringify({ scripts: { prova: "node prova-run.cjs" } })}\n`,
        provaRunCjs: [
          'const fs = require("fs");',
          'const path = require("path");',
          "const slug = process.argv[2];",
          'const outDir = path.join(__dirname, ".prova", slug);',
          "fs.mkdirSync(outDir, { recursive: true });",
          'fs.writeFileSync(path.join(outDir, "resumo.json"), JSON.stringify({ total: 1 }) + "\\n");',
          "process.exit(1);",
          "",
        ].join("\n"),
      });
      const base = commitTudo(dir, "chore: harness com resumo.json quebrado (sem 'ok')");
      escreverTeste(dir, "x");
      const head = commitTudo(dir, "test(red): cobre x");

      const result = rodar(dir, base, head, "x");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(".prova/x/resumo.json");
      expect(result.stderr).toContain('"ok"');
    },
    TIMEOUT_TESTE,
  );

  it(
    "cita a causa do npm run prova quando a base não produz resumo.json",
    () => {
      const dir = novoRepo({ provaRunCjs: "process.exit(7);\n" });
      const base = commitTudo(dir, "chore: harness quebrado (nunca escreve resumo.json)");
      escreverTeste(dir, "y");
      const head = commitTudo(dir, "test(red): cobre y");

      const result = rodar(dir, base, head, "y");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("resumo.json");
      expect(result.stderr).toContain("exit code 7");
    },
    TIMEOUT_TESTE,
  );

  it(
    "exit 1 e sem diretório temporário vazando quando git worktree add falha (base inexistente)",
    () => {
      const { dir, head, slug } = repoAssertionRed();
      const baseInvalida = "0".repeat(40);
      const antes = readdirSync(tmpdir()).filter((nome) => nome.startsWith("controle-negativo-"));

      const result = rodar(dir, baseInvalida, head, slug);

      expect(result.status).toBe(1);
      const depois = readdirSync(tmpdir()).filter((nome) => nome.startsWith("controle-negativo-"));
      expect(depois).toEqual(antes);
    },
    TIMEOUT_TESTE,
  );

  it(
    "git ausente (PATH vazio): exit 1, mensagem com ENOENT (issue #62)",
    () => {
      const { dir, base, head, slug } = repoAssertionRed();

      const result = rodarComPathVazio(dir, base, head, slug);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ENOENT");
    },
    TIMEOUT_TESTE,
  );

  it(
    "SKIP quando o diff é só tests/** (sem --slug, sem prova/<slug>.ts algum) — issue #114",
    () => {
      // Sem --slug e sem `prova/<slug>.ts` no HEAD, o fluxo normal
      // reprovaria pedindo --slug/--branch antes mesmo de chegar em
      // `resolverSlug` — o SKIP precisa disparar ANTES disso.
      const dir = novoRepo();
      const base = commitTudo(dir, "chore: repo vazio");
      escreverTeste(dir, "so-teste");
      const head = commitTudo(dir, "test(red): cobre so-teste, sem produção nenhuma");

      const { result, summary } = runControleNegativoComSummary([
        "--root",
        dir,
        "--base",
        base,
        "--head",
        head,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SKIP — diff só de tests/**+prova/**: base+overlay ≡ head");
      expect(summary).toContain("base+overlay ≡ head");
    },
    TIMEOUT_TESTE,
  );

  it(
    "SKIP no caso concreto da PR #113/#111: tests/** + prova/<slug>.ts NOVO, sem produção",
    () => {
      const dir = novoRepo();
      const base = commitTudo(dir, "chore: repo vazio");
      escreverTeste(dir, "prova-run-timeout");
      const head = commitTudo(dir, "test(red): cobre timeout, prova/<slug>.ts novo");

      const result = rodar(dir, base, head, "prova-run-timeout");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("o controle não discrimina");
    },
    TIMEOUT_TESTE,
  );

  it(
    "NÃO faz SKIP quando há src/** no diff além de tests/** — mecânica normal (issue #114)",
    () => {
      const { dir, base, head, slug } = repoAssertionRed();

      const result = rodar(dir, base, head, slug);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("assertion-red");
      expect(result.stdout).not.toContain("SKIP");
    },
    TIMEOUT_TESTE,
  );

  it(
    "NÃO faz SKIP quando o único arquivo fora de docs/process é uma declaração de prova sozinha (sem tests/**)",
    () => {
      // Mesmo repo/diff do teste "NÃO faz SKIP quando a declaração de prova
      // é NOVA" (SKIP de declaração existente) — aqui a garantia é que o
      // novo SKIP overlay-only também não dispara para esse caso: uma
      // declaração de prova sozinha, sem nenhum tests/**, não é "correção
      // só de teste" (User Story da issue #114).
      const dir = novoRepo();
      const base = commitTudo(dir, "chore: repo vazio");

      writeFileSync(join(dir, "CLAUDE.md"), "# nota\n");
      mkdirSync(join(dir, "prova"), { recursive: true });
      writeFileSync(join(dir, "prova", "nova-feature.ts"), "export default { unit: [] };\n");
      const head = commitTudo(dir, "feat: declara prova de nova-feature (sem testes ainda)");

      const result = runControleNegativo(["--root", dir, "--base", base, "--head", head]);

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("SKIP");
    },
    TIMEOUT_TESTE,
  );
});
