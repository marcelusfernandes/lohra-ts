// Integração de ponta a ponta do `controle-negativo` (issue #48), em
// repositórios git temporários e descartáveis — via subprocesso (`run.ts`).
// Extraído de `tests/ci-controle-negativo.test.ts` (issue #62, divisão do
// arquivo de 862 linhas — AC "arquivos < 800 linhas"); os testes puros e
// unitários (com git injetado) ficaram lá. Os três casos novos das lacunas
// da issue #117 (fixture, deleção, teste inteiramente novo) foram para
// `tests/ci-controle-negativo-lacunas.test.ts` (rodada 2 do revisor da PR
// #119 — este arquivo tinha passado de 800 linhas); os helpers de
// repositório git ficaram em `tests/helpers/controle-negativo-repo.ts`,
// reusados pelos dois arquivos.
//
// Timeout explícito (60s) em todo teste que spawna `tsx` + `git worktree` +
// um `npm run prova` aninhado — o default do vitest (5s) já estourou uma vez
// nesta suíte rodando em paralelo com outra suíte na mesma máquina.
//
// Issue #122: o teste de vazamento de diretório temporário lia
// `readdirSync(tmpdir())` GLOBAL, compartilhado com toda a suíte (o mesmo
// prefixo `controle-negativo-` é usado por `novoRepo()` aqui, pelas
// fixtures unitárias de `ci-controle-negativo.test.ts` e por `run.ts`
// mesmo) — uma corrida entre arquivos de teste rodando em paralelo
// (vitest, threads por arquivo) derrubava a comparação antes/depois
// intermitentemente, sem vazamento real nenhum. Corrigido isolando o
// `TMPDIR` do subprocesso por execução (`runControleNegativoComEnv`).
//
// Fora de escopo desta correção (pré-existente, não coberto por nenhum
// teste antes nem depois): não há como forçar `git worktree add` a falhar
// com uma base VÁLIDA (para exercitar `registrado=false` seguido do
// `rmSync` de `worktreeRemove` em `run.ts`) sem depender de condição de
// corrida ou de mock de `git` — o cenário de base inexistente (abaixo)
// reprova antes disso, em `diffNomeStatus`.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  commitTudo,
  escreverTeste,
  git,
  gitCapture,
  limparWorkdirs,
  novoRepo,
  PROVA_RUN_CJS,
  repoAssertionRed,
  repoStructuralRed,
  repoVacuousPass,
  rodar,
  rodarComPathVazio,
  runControleNegativo,
  runControleNegativoComEnv,
  runControleNegativoComSummary,
  TIMEOUT_TESTE,
} from "./helpers/controle-negativo-repo.js";

afterEach(limparWorkdirs);

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
    "exit 1 sem workdir vazando quando a base é inexistente (reprova em diffNomeStatus, antes de mkdtempSync) — checagem isolada do tmpdir global (issue #122)",
    () => {
      const { dir, head, slug } = repoAssertionRed();
      const baseInvalida = "0".repeat(40);

      // TMPDIR isolado por execução (issue #122): `run.ts` (linha ~435)
      // cria seu workdir com `mkdtempSync(tmpdir(), "controle-negativo-")`,
      // e `os.tmpdir()` do Node lê `TMPDIR` do processo A CADA CHAMADA (não
      // cacheado no startup) — sobrescrever só para o subprocesso basta
      // para que ele nasça aqui dentro, onde mais ninguém escreve. Antes,
      // a checagem lia o tmpdir GLOBAL, compartilhado com toda a suíte
      // (`ci-controle-negativo.test.ts`'s fixtures "overlay-*", `novoRepo()`
      // de qualquer arquivo que importe este helper) — uma corrida entre
      // arquivos de teste rodando em paralelo (vitest, um worker por
      // arquivo) fazia a lista global divergir entre "antes" e "depois",
      // sem vazamento real nenhum deste teste (PR #120).
      const tmpIsolado = mkdtempSync(join(tmpdir(), "controle-negativo-leak-check-"));
      try {
        const result = runControleNegativoComEnv(
          ["--root", dir, "--base", baseInvalida, "--head", head, "--slug", slug],
          { TMPDIR: tmpIsolado },
        );

        // Ruído concorrente simulado (mesma reprodução do commit
        // `test(red):` desta issue) — outro teste criando um repositório
        // fake com o mesmo prefixo no tmpdir GLOBAL durante a janela. A
        // checagem abaixo, presa ao diretório isolado, fica imune a isso.
        novoRepo();

        // Com uma base que nunca existiu, `diffNomeStatus` (main():571)
        // reprova ANTES de `rodarCheck`/`mkdtempSync` (linha ~435) — este
        // cenário nunca chega a criar um workdir de verdade (isso é
        // exercitado pelo controle positivo abaixo, com base válida).
        // Fixar a causa aqui, em vez de só o exit code, prende o cenário
        // real e evita o título divergir de novo do que o teste cobre.
        expect(result.stderr).toContain("git diff --name-status");
        expect(result.status).toBe(1);
        const dentroDoIsolado = readdirSync(tmpIsolado).filter((nome) =>
          nome.startsWith("controle-negativo-"),
        );
        expect(dentroDoIsolado).toEqual([]);
      } finally {
        rmSync(tmpIsolado, { recursive: true, force: true });
      }
    },
    TIMEOUT_TESTE,
  );

  it(
    "TMPDIR isolado é onde run.ts de fato cria e limpa o workdir — controle positivo do isolamento acima (issue #122)",
    () => {
      // O teste anterior prova "nada sobrou no diretório isolado" — o que
      // seria vácuo se `run.ts` ignorasse o `TMPDIR` sobrescrito e usasse o
      // tmpdir global de qualquer jeito (o isolado ficaria vazio por não
      // ser usado, não por limpeza correta). Este cenário usa uma base
      // válida — chega em `rodarCheck`, que de fato chama `mkdtempSync` e
      // roda `npm run prova` com `cwd: tmpDir` — e confirma que o
      // subprocesso escreveu DENTRO do diretório isolado antes de limpar.
      const provaRunComCwd = `process.stdout.write(process.cwd() + "\\n");\n${PROVA_RUN_CJS}`;
      const dir = novoRepo({ provaRunCjs: provaRunComCwd });
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

      const tmpIsolado = mkdtempSync(join(tmpdir(), "controle-negativo-leak-check-"));
      try {
        const result = runControleNegativoComEnv(
          ["--root", dir, "--base", base, "--head", head, "--slug", "soma"],
          { TMPDIR: tmpIsolado },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("assertion-red");
        // `realpathSync`: no macOS, `tmpdir()` devolve `/var/folders/...`,
        // mas `process.cwd()` do subprocesso resolve para `/private/var/...`
        // (symlink) — comparar caminhos resolvidos evita falso negativo.
        expect(result.stdout).toContain(realpathSync(tmpIsolado));

        const dentroDoIsolado = readdirSync(tmpIsolado).filter((nome) =>
          nome.startsWith("controle-negativo-"),
        );
        expect(dentroDoIsolado).toEqual([]);
      } finally {
        rmSync(tmpIsolado, { recursive: true, force: true });
      }
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
    "SKIP quando o diff é só um tests/** JÁ EXISTENTE editado (sem --slug) — issue #114",
    () => {
      // O `tests/**` precisa já existir na base (EDITADO, não criado) —
      // ver `lib.ts#soArquivosDoOverlay`. Sem --slug e sem `prova/<slug>.ts`
      // novo no diff, o fluxo normal reprovaria pedindo --slug/--branch
      // antes mesmo de chegar em `resolverSlug` — o SKIP precisa disparar
      // ANTES disso.
      const dir = novoRepo();
      escreverTeste(dir, "so-teste");
      const base = commitTudo(dir, "chore: so-teste já existe (sem produção)");

      writeFileSync(
        join(dir, "tests", "so-teste.test.ts"),
        "module.exports.run = function () { /* editado */ };\n",
      );
      const head = commitTudo(dir, "test(red): edita so-teste, sem produção nenhuma");

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
    "SKIP no caso concreto da PR #113/#111: tests/** JÁ EXISTENTE editado + prova/<slug>.ts NOVO",
    () => {
      // Reproduz exatamente a forma do diff real (`git diff --name-status`
      // contra o merge-base): `M tests/prova-run.test.ts` + `A
      // prova/prova-run-timeout.ts` — o teste já existia na base (sem
      // `prova/<slug>.ts` declarado ainda), só a declaração é nova.
      const dir = novoRepo();
      mkdirSync(join(dir, "tests"), { recursive: true });
      writeFileSync(
        join(dir, "tests", "prova-run-timeout.test.ts"),
        "module.exports.run = function () {};\n",
      );
      const base = commitTudo(dir, "chore: teste existente, sem prova declarada ainda");

      mkdirSync(join(dir, "prova"), { recursive: true });
      writeFileSync(
        join(dir, "prova", "prova-run-timeout.ts"),
        "// declaração de prova (fixture de teste)\n",
      );
      writeFileSync(
        join(dir, "tests", "prova-run-timeout.test.ts"),
        "module.exports.run = function () { /* cobre timeout */ };\n",
      );
      const head = commitTudo(dir, "test(red): cobre timeout, declara prova/<slug>.ts novo");

      const result = rodar(dir, base, head, "prova-run-timeout");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("o controle não discrimina");
    },
    TIMEOUT_TESTE,
  );

  it(
    "NÃO faz SKIP quando o tests/** do diff é inteiramente NOVO (ausente na base), mesmo sem produção — mecânica normal (issue #114)",
    () => {
      // Mesma forma de `repoVacuousPass` — `tests/**` novo sem produção
      // continua sendo controlado (e reprova em vacuous-pass), não vira
      // SKIP silencioso: só um `tests/**` EDITADO qualifica. A variante com
      // commit `test(red):` (SKIP e reprova citando a exigência) está em
      // `tests/ci-controle-negativo-lacunas.test.ts` (issue #117, lacuna 3).
      const { dir, base, head, slug } = repoVacuousPass();

      const result = rodar(dir, base, head, slug);

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("SKIP");
      expect(result.stderr).toContain("vacuous-pass");
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

// Issue #137: os três helpers que ainda lançavam `tsx` pelo wrapper
// `tsx/dist/cli.mjs` (direto ou via o shim `node_modules/.bin/tsx`, que é um
// symlink para o mesmo `cli.mjs`) precisam trocar para `node --import <tsx
// loader>`, igual a `scripts/parity/gateway/launch-candidate.ts` (issue
// #132) — um processo real, sem o handshake de sinal do wrapper. Escaneia o
// texto-fonte dos arquivos-alvo (os `ci-*.test.ts` que fazem `spawnSync`
// direto, o helper compartilhado do controle-negativo, e — issue #142,
// follow-up da #137 — `tests/prova-run.test.ts`, o último spawn de `npm
// test` que ainda passava pelo shim `.bin/tsx`) em vez de rodar `grep` num
// subprocesso — mais rápido e sem depender de `grep` estar no PATH.
describe("tsx sem wrapper nos helpers de teste (issue #137)", () => {
  const arquivosAlvo = [
    resolve(import.meta.dirname, "ci-contratos.test.ts"),
    resolve(import.meta.dirname, "ci-escopo.test.ts"),
    resolve(import.meta.dirname, "helpers", "controle-negativo-repo.ts"),
    resolve(import.meta.dirname, "prova-run.test.ts"),
  ];

  it("nenhum lança tsx pelo wrapper (cli.mjs ou o shim .bin/tsx) — todos usam --import", () => {
    for (const caminho of arquivosAlvo) {
      const conteudo = readFileSync(caminho, "utf8");
      expect(conteudo, `${caminho}: não pode resolver node_modules/tsx/dist/cli.mjs`).not.toContain(
        "node_modules/tsx/dist/cli.mjs",
      );
      expect(conteudo, `${caminho}: não pode resolver node_modules/.bin/tsx`).not.toContain(
        "node_modules/.bin/tsx",
      );
      expect(conteudo, `${caminho}: precisa lançar tsx via --import`).toContain("--import");
    }
  });
});
