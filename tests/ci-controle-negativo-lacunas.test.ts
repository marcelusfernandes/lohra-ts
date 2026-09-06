// Integração das três lacunas do SKIP "diff só de teste" fechadas pela
// issue #117 (follow-up do veredito do revisor na PR #116, issue #114):
// fixture não deveria contar como "tests/** já existente" (lacuna 1, testada
// no nível puro em `tests/ci-controle-negativo.test.ts`), deleção não é
// SKIP (lacuna 2), e teste inteiramente novo sem produção ganha uma saída
// mecânica (lacuna 3). Extraído de `tests/ci-controle-negativo-integracao.test.ts`
// na rodada 2 do revisor da PR #119 (`arquivo-grande`: 755 → 829 linhas) —
// os helpers de repositório git ficaram em `tests/helpers/controle-negativo-repo.ts`,
// reusados pelos dois arquivos.
import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  commitTudo,
  escreverTeste,
  limparWorkdirs,
  novoRepo,
  repoVacuousPass,
  rodar,
  runControleNegativo,
  runControleNegativoComSummary,
  TIMEOUT_TESTE,
} from "./helpers/controle-negativo-repo.js";

afterEach(limparWorkdirs);

describe("controle-negativo/run.ts — lacunas da issue #117 (subprocesso, repositório git descartável)", () => {
  it(
    "NÃO faz SKIP quando o diff é só a DELEÇÃO de um tests/** que existia na base (issue #117, lacuna 2)",
    () => {
      // `git cat-file -e base:<arquivo>` acerta para um arquivo deletado
      // (ele existe na base, é o que está sendo apagado) — sem excluir
      // status "D", isso virava SKIP indevido; antes da #114 era controlado
      // (vacuous-pass por construção, mesmo raciocínio de repoVacuousPass).
      // Sem --slug/--branch reconhecível, o fluxo normal reprova em
      // resolverSlug (branch local "main" não segue <type>/<n>-<slug>) —
      // o ponto do teste é que NUNCA chega a fazer SKIP antes disso.
      const dir = novoRepo();
      escreverTeste(dir, "del-teste");
      const base = commitTudo(dir, "chore: del-teste existe na base");

      rmSync(join(dir, "tests", "del-teste.test.ts"));
      const head = commitTudo(dir, "chore: remove tests/del-teste.test.ts");

      const result = runControleNegativo(["--root", dir, "--base", base, "--head", head]);

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("SKIP");
    },
    TIMEOUT_TESTE,
  );

  it(
    "SKIP quando o tests/** do diff é inteiramente NOVO E existe um commit test(red): que o toca (issue #117, lacuna 3)",
    () => {
      // Mesma forma de repoVacuousPass (teste novo, sem produção, vacuous
      // por construção), mas com o commit test(red): que a issue #114
      // (Contexto item 3) deixou sem saída mecânica — vira SKIP citando o
      // sha, para o revisor conferir manualmente.
      const dir = novoRepo();
      const base = commitTudo(dir, "chore: repo vazio");
      escreverTeste(dir, "vazio-red");
      const head = commitTudo(dir, "test(red): cobre vazio-red (sem produção nenhuma)");

      const { result, summary } = runControleNegativoComSummary([
        "--root",
        dir,
        "--base",
        base,
        "--head",
        head,
        "--slug",
        "vazio-red",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SKIP");
      expect(result.stdout).toContain(`test(red): ${head}`);
      expect(summary).toContain(`test(red): ${head}`);
    },
    TIMEOUT_TESTE,
  );

  it(
    "reprova citando a exigência quando o tests/** do diff é inteiramente NOVO e NÃO há commit test(red): (issue #117, lacuna 3)",
    () => {
      // Mesmo repoVacuousPass do teste equivalente em
      // ci-controle-negativo-integracao.test.ts — a diferença é a mensagem:
      // antes desta issue, o motivo era só "vacuous-pass"; agora nomeia a
      // exigência que faltou (nenhum commit test(red): em base..head que
      // toque os testes do diff).
      const { dir, base, head, slug } = repoVacuousPass();

      const result = rodar(dir, base, head, slug);

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("SKIP");
      expect(result.stderr).toContain("vacuous-pass");
      expect(result.stderr).toContain("test(red)");
    },
    TIMEOUT_TESTE,
  );
});
