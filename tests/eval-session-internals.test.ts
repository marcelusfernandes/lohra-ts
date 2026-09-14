// Issue #607: unit tests dos blocos internos de `scripts/eval/session.ts`
// que não dependem de rede nem do stub — `runInProcess` (a máquina de
// `process.chdir`/timeout, item 7) e `buildProviderEnvironment` (o
// isolamento de profile do modo `--provider`, item 2). Nunca spawna o CLI
// real contra rede; a "chamada lenta" é sempre uma Promise controlada pelo
// próprio teste.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildProviderEnvironment,
  runInProcess,
  type CliInvoker,
} from "../scripts/eval/session.js";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-eval-session-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("runInProcess: restauração de cwd (issue #607 item 7)", () => {
  // Reproduz o bug relatado (session.ts, antes da correção, com o
  // `previousCwd` de cada chamada recapturado via `process.cwd()`): um
  // caso que estoura `timeoutMs` (a chamada real, `invokeSlow` aqui, segue
  // "rodando em segundo plano" sem nunca resolver dentro do teste) tem seu
  // diretório temporário removido pelo CHAMADOR (como `runEvalCase` fazia
  // em `finally`, sem restaurar o cwd antes) — o cwd ATIVO do processo
  // continua apontando para esse diretório já apagado. Contra o código
  // antigo isso derrubava o teste de uma entre duas formas (dependente de
  // timing/plataforma, ambas com a mesma causa raiz): o `process.cwd()` do
  // PRÓXIMO caso lançando `ENOENT` (`uv_cwd`) — o que este teste
  // efetivamente reproduziu localmente — ou um `process.chdir(previousCwd)`
  // tardio da chamada perdida do caso A lançando `ENOENT` como rejeição
  // não tratada (`unhandled`, abaixo) por `previousCwd` ter sido, ele
  // mesmo, um caminho já removido. `PROJECT_ROOT_CWD` (a correção) elimina
  // as duas.
  it("a slow call that outlives the timeout never corrupts a later case's cwd restore", async () => {
    const startedAt = process.cwd();
    const rootA = tempDir();
    const rootB = tempDir();

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      let resolveSlow: (exitCode: number) => void = () => {
        throw new Error("resolveSlow chamado antes de ser atribuído");
      };
      const slow = new Promise<number>((resolve) => {
        resolveSlow = resolve;
      });
      const invokeSlow: CliInvoker = () => slow;

      // Caso A: a chamada nunca resolve dentro do timeout minúsculo —
      // `runInProcess` devolve pelo braço do timeout, com a invocação real
      // ainda pendente (igual a uma chamada de provedor real travada).
      const resultA = await runInProcess([], {}, rootA, 5, invokeSlow);
      expect(resultA.timedOut).toBe(true);

      // O chamador (`runEvalCase`, em produção) remove o diretório do caso
      // A assim que ele "termina" — mesmo com a chamada real ainda presa
      // em segundo plano e o cwd do processo ainda podendo apontar para lá.
      rmSync(rootA, { recursive: true, force: true });

      // Caso B roda a seguir, independente — nunca deveria falhar por
      // causa de um estado deixado pelo caso A. Contra o código antigo,
      // este `await` é justamente onde `process.cwd()` lançava `ENOENT`
      // (o `it` inteiro falhava aqui, antes de chegar em qualquer
      // `expect` — não é o `expect(unhandled)` abaixo que pegava essa
      // manifestação específica).
      const resultB = await runInProcess([], {}, rootB, 1000, () => Promise.resolve(0));
      expect(resultB.exitCode).toBe(0);
      expect(resultB.timedOut).toBe(false);
      rmSync(rootB, { recursive: true, force: true });

      // A chamada perdida do caso A finalmente resolve — seu `.finally`
      // (não aguardado por ninguém) tenta restaurar o cwd agora. Antes da
      // correção, isso reaplicava `process.chdir(previousCwd)` com
      // `previousCwd` já potencialmente inválido; hoje sempre restaura
      // para a raiz do processo, que nunca é removida pelo harness.
      resolveSlow(0);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(unhandled).toEqual([]);
      expect(process.cwd()).toBe(startedAt);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

describe("buildProviderEnvironment (issue #607 item 2)", () => {
  it("defaults LOHRA_PROFILE to 'eval' so a --provider baseline never lands in the operator's default profile", () => {
    const environment = buildProviderEnvironment({ HOME: "/home/operator", PATH: "/bin" });
    expect(environment.LOHRA_PROFILE).toBe("eval");
    expect(environment.HOME).toBe("/home/operator");
  });

  it("respects a profile the operator already exported instead of overriding it", () => {
    const environment = buildProviderEnvironment({ LOHRA_PROFILE: "personal-dev" });
    expect(environment.LOHRA_PROFILE).toBe("personal-dev");
  });

  it("still carries LOHRA_NO_WIZARD and NO_COLOR, same as before the profile default existed", () => {
    const environment = buildProviderEnvironment({});
    expect(environment.LOHRA_NO_WIZARD).toBe("1");
    expect(environment.NO_COLOR).toBe("1");
  });
});
