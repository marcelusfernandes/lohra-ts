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
  // A expira, mas sua invocação fica pendente. B começa enquanto o cwd ainda
  // aponta para A: uma restauração que recaptura previousCwd por chamada
  // voltaria para A, enquanto PROJECT_ROOT_CWD volta à raiz estável.
  // A fixture só remove cada raiz após restaurar o cwd, como runEvalCase.
  it("a slow call that outlives the timeout never corrupts a later case's cwd restore", async () => {
    const startedAt = process.cwd();
    const rootA = tempDir();
    const rootB = tempDir();

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    let resolveSlow: ((exitCode: number) => void) | undefined;
    let slowPending = false;
    let failure: { error: unknown } | undefined;
    const cleanupErrors: unknown[] = [];
    try {
      const slow = new Promise<number>((resolve) => {
        resolveSlow = resolve;
      });
      slowPending = true;
      const invokeSlow: CliInvoker = () => slow;

      // Caso A: a chamada nunca resolve dentro do timeout minúsculo —
      // `runInProcess` devolve pelo braço do timeout, com a invocação real
      // ainda pendente (igual a uma chamada de provedor real travada).
      const resultA = await runInProcess([], {}, rootA, 5, invokeSlow);
      expect(resultA.timedOut).toBe(true);
      expect(process.cwd()).toBe(rootA);

      // B começa antes de A resolver; não restauramos A prematuramente,
      // pois isso deixaria previousCwd dinâmico indistinguível.
      const resultB = await runInProcess([], {}, rootB, 1000, () => Promise.resolve(0));
      expect(resultB.exitCode).toBe(0);
      expect(resultB.timedOut).toBe(false);
      expect(slowPending).toBe(true);
      expect(process.cwd()).toBe(startedAt);

      // O chamador restaura antes de remover qualquer cwd temporário ativo.
      process.chdir(startedAt);
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });

      // Só agora a invocação tardia de A resolve e executa seu `.finally`.
      resolveSlow?.(0);
      slowPending = false;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(process.cwd()).toBe(startedAt);
    } catch (error) {
      failure = { error };
    } finally {
      if (slowPending) resolveSlow?.(0);
      let restored = false;
      try {
        process.chdir(startedAt);
        restored = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (restored) {
        for (const root of [rootA, rootB]) {
          try {
            rmSync(root, { recursive: true, force: true });
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
      process.off("unhandledRejection", onUnhandledRejection);
    }
    if (failure !== undefined) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [failure.error, ...cleanupErrors],
          "Falha e limpeza do cwd de eval",
        );
      }
      throw failure.error;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Falha na limpeza do cwd de eval");
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

  it("treats an empty LOHRA_PROFILE the same as an absent one, never as an explicit choice (issue #653 item 2)", () => {
    const environment = buildProviderEnvironment({ LOHRA_PROFILE: "" });
    expect(environment.LOHRA_PROFILE).toBe("eval");
  });

  it("still carries LOHRA_NO_WIZARD and NO_COLOR, same as before the profile default existed", () => {
    const environment = buildProviderEnvironment({});
    expect(environment.LOHRA_NO_WIZARD).toBe("1");
    expect(environment.NO_COLOR).toBe("1");
  });
});
