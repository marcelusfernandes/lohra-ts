// Issue #3: o stub-driver colidia com a porta fixa 11434 sob vitest
// paralelo (e com um Ollama real na máquina do dev). Os testes abaixo que
// exercitam a vinculação de porta usam `port: 0` no config (porta efêmera,
// atribuída pelo SO) e leem a porta de fato vinculada de volta em
// `summary.json` — o driver a reporta ali porque é a única saída que
// sobrevive ao processo filho encerrar. Nenhum teste deste arquivo vincula
// mais um número de porta fixo e conhecido.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { completion } from "../../scripts/parity/stub/server.js";

const driver = new URL("../../scripts/parity/stub/driver.ts", import.meta.url);
const tsxLoader = import.meta.resolve("tsx");

it("keeps usage in default completions and omits it only when requested", () => {
  const message = { role: "assistant", content: "ok" };
  expect(completion(message, "stop")).toMatchObject({
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
  expect(completion(message, "stop", false)).not.toHaveProperty("usage");
});

async function bindPort(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function stubPortFromSummary(root: string): number {
  const summary = JSON.parse(readFileSync(join(root, "summary.json"), "utf8")) as {
    readonly port?: number | null;
  };
  expect(
    summary.port,
    "o driver precisa reportar a porta efêmera que de fato vinculou em summary.json",
  ).toBeTypeOf("number");
  return summary.port as number;
}

it("kills a timed-out target tree and releases the stub port before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "lohra-stub-driver-test-"));
  try {
    const config = join(root, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        scenario: "timeout-lifecycle",
        side: "oracle",
        port: 0,
        stub: {
          state: "up-with-models",
          fixture: "doctor",
          requestLog: { comparedHeaders: [], excludedHeaders: [] },
        },
        limits: { timeoutMs: 100, maxOutputBytes: 16_384 },
        target: {
          executable: process.execPath,
          argv: ["--input-type=module", "-e", "setTimeout(() => {}, 5000)"],
          cwd: root,
          environment: { PATH: "/usr/bin:/bin" },
        },
        logs: {
          projected: join(root, "projected.jsonl"),
          raw: join(root, "raw.jsonl"),
          summary: join(root, "summary.json"),
          assertions: join(root, "assertions.json"),
        },
      }),
    );

    const result = spawnSync(process.execPath, ["--import", tsxLoader, driver.pathname, config], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(88);
    const port = stubPortFromSummary(root);
    await bindPort(port);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Tenta ocupar 11434 para simular um Ollama real (ou outro worker do
// vitest) já escutando ali. Se a porta já estiver ocupada por outra coisa
// (o próprio cenário que este teste quer cobrir), não é um erro — o
// precondition desejado já vale, então segue sem o próprio bind.
async function tryOccupy11434(): Promise<ReturnType<typeof createServer> | undefined> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(11_434, "127.0.0.1", resolve);
    });
    return server;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return undefined;
    throw error;
  }
}

it("kills a timed-out target tree even when 127.0.0.1:11434 is already occupied by another process", async () => {
  const root = mkdtempSync(join(tmpdir(), "lohra-stub-driver-occupied-"));
  const occupier = await tryOccupy11434();
  try {
    const config = join(root, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        scenario: "timeout-lifecycle-under-occupied-11434",
        side: "oracle",
        port: 0,
        stub: {
          state: "up-with-models",
          fixture: "doctor",
          requestLog: { comparedHeaders: [], excludedHeaders: [] },
        },
        limits: { timeoutMs: 100, maxOutputBytes: 16_384 },
        target: {
          executable: process.execPath,
          argv: ["--input-type=module", "-e", "setTimeout(() => {}, 5000)"],
          cwd: root,
          environment: { PATH: "/usr/bin:/bin" },
        },
        logs: {
          projected: join(root, "projected.jsonl"),
          raw: join(root, "raw.jsonl"),
          summary: join(root, "summary.json"),
          assertions: join(root, "assertions.json"),
        },
      }),
    );

    const result = spawnSync(process.execPath, ["--import", tsxLoader, driver.pathname, config], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(88);
    const port = stubPortFromSummary(root);
    expect(port, "a porta efêmera nunca deve coincidir com a porta ocupada").not.toBe(11_434);
  } finally {
    if (occupier !== undefined) {
      await new Promise<void>((resolve, reject) => {
        occupier.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

it("installs the dynamic-port redirect for candidate targets too", () => {
  const root = mkdtempSync(join(tmpdir(), "lohra-stub-driver-candidate-"));
  try {
    const config = join(root, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        scenario: "candidate-dynamic-port",
        side: "candidate",
        port: 0,
        stub: {
          state: "up-with-models",
          fixture: "doctor",
          requestLog: { comparedHeaders: [], excludedHeaders: [] },
        },
        limits: { timeoutMs: 5_000, maxOutputBytes: 16_384 },
        target: {
          executable: process.execPath,
          argv: [
            "--input-type=module",
            "-e",
            "process.stdout.write(JSON.stringify({ pythonPath: process.env.PYTHONPATH, original: process.env.LOHRA_PARITY_ORIGINAL_PYTHONPATH }))",
          ],
          cwd: root,
          environment: { PATH: "/usr/bin:/bin", PYTHONPATH: "/original" },
        },
        logs: {
          projected: join(root, "projected.jsonl"),
          raw: join(root, "raw.jsonl"),
          summary: join(root, "summary.json"),
          assertions: join(root, "assertions.json"),
        },
      }),
    );

    const result = spawnSync(process.execPath, ["--import", tsxLoader, driver.pathname, config], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const environment = JSON.parse(result.stdout) as {
      readonly pythonPath?: string;
      readonly original?: string;
    };
    expect(environment.original, "MUTATION_CAUSE:T22-candidate-dynamic-stub-redirect").toBe(
      "/original",
    );
    expect(environment.pythonPath, "MUTATION_CAUSE:T22-candidate-dynamic-stub-redirect").toContain(
      "python-sitecustomize",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
