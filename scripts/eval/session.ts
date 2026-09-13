// Issue #576: roda UM caso de eval — inicia o stub em processo (modo
// "stub"; `startStub` já é usado assim por
// `tests/parity/stub-lane-script.test.ts`), sobe o CLI já buildado
// (`dist/cli.js`) como processo filho apontado para o stub, e devolve o
// envelope e as requisições cruas capturadas para os oráculos julgarem.
//
// Isolamento (AC "nunca faz rede sem --provider"): o ambiente do processo
// filho em modo stub é uma allowlist literal, nunca `...process.env` — a
// única forma de rede possível é para o stub local. Em modo "provider" o
// ambiente real É herdado de propósito (as credenciais vivem em
// `~/.lohra/.env`, fora do repo) e isso só acontece quando quem chama
// `runEvalCase` passou `--provider` explicitamente (`run.ts` recusa isso em
// CI antes de chegar aqui).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import { startStub } from "../stub/server.js";
import type { StubRuntime } from "../stub/types.js";
import type { CapturedRequest, EvalCase } from "./types.js";

export interface EvalRunOptions {
  readonly cliPath: string;
  readonly provider?: string;
  readonly timeoutMs: number;
}

export interface EvalSessionResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly envelope: Record<string, unknown> | null;
  readonly envelopeParseError: string | null;
  readonly stderr: string;
  readonly requests: readonly CapturedRequest[];
}

const HEADER_ALLOWLIST_EXCLUDED = [
  "authorization",
  "accept",
  "content-type",
  "host",
  "accept-encoding",
  "connection",
  "content-length",
  "user-agent",
];

function readCapturedRequests(path: string): readonly CapturedRequest[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CapturedRequest);
}

async function startCaseStub(
  kase: EvalCase,
  root: string,
): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
  readonly projectedLog: string;
}> {
  const projectedLog = join(root, "stub-requests.jsonl");
  const rawLog = join(root, "stub-requests-raw.jsonl");
  mkdirSync(dirname(projectedLog), { recursive: true });
  writeFileSync(projectedLog, "");
  writeFileSync(rawLog, "");
  const runtime: StubRuntime = {
    fixture: "chat-lane-script",
    state: "up-with-models",
    scenario: kase.id,
    side: "candidate",
    comparedHeaders: [],
    excludedHeaders: HEADER_ALLOWLIST_EXCLUDED,
    projectedLog,
    rawLog,
    failures: [],
    sequence: [],
    toolSequence: [],
    laneSteps: kase.stubScript,
    laneStepIndex: new Map(),
    latches: new Map(),
    posts: 0,
    requests: 0,
  };
  const server = await startStub(runtime, 0);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    projectedLog,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        server.closeAllConnections();
      }),
  };
}

function spawnCli(
  cliPath: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
  cwd: string,
  timeoutMs: number,
): Promise<{
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), timedOut, stdout, stderr });
    });
  });
}

function definedEntries(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function parseEnvelope(stdout: string): {
  envelope: Record<string, unknown> | null;
  error: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) {
      return { envelope: null, error: "envelope não é um objeto JSON" };
    }
    return { envelope: parsed as Record<string, unknown>, error: null };
  } catch (error) {
    return { envelope: null, error: `stdout não é JSON válido: ${String(error)}` };
  }
}

/** Roda um caso contra o stub local (`options.provider` ausente) ou contra
 * um provedor real (`options.provider` presente) e devolve o envelope mais
 * as requisições capturadas — vazio em modo "provider", já que não há stub
 * local interceptando a chamada real (ver nota em `oracles.ts`/`docs/eval.md`
 * sobre o oráculo de mecanismo não rodar nesse modo). */
export async function runEvalCase(
  kase: EvalCase,
  options: EvalRunOptions,
): Promise<EvalSessionResult> {
  const root = mkdtempSync(join(tmpdir(), `lohra-eval-${kase.id}-`));
  try {
    if (options.provider === undefined) {
      const stub = await startCaseStub(kase, root);
      try {
        const home = join(root, "home");
        mkdirSync(join(home, "profiles", "eval"), { recursive: true });
        if (kase.cwdFixture !== undefined) {
          const fixturePath = join(home, kase.cwdFixture.path);
          mkdirSync(dirname(fixturePath), { recursive: true });
          writeFileSync(fixturePath, kase.cwdFixture.content);
        }
        const environment: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          HOME: home,
          LOHRA_HOME: home,
          LOHRA_NO_WIZARD: "1",
          NO_COLOR: "1",
          LOHRA_PROVIDER_BASE_URL: `http://127.0.0.1:${String(stub.port)}/v1`,
          LOHRA_OLLAMA_CONNECT_URL: `http://127.0.0.1:${String(stub.port)}/api/tags`,
        };
        const argv = [
          "chat",
          "--json",
          "--no-input",
          "--provider",
          "ollama",
          "--model",
          "stub-coder:1b",
          "--profile",
          "eval",
          "--max-iterations",
          "10",
          kase.input,
        ];
        const run = await spawnCli(options.cliPath, argv, environment, home, options.timeoutMs);
        const { envelope, error } = parseEnvelope(run.stdout);
        return {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          envelope,
          envelopeParseError: error,
          stderr: run.stderr,
          requests: readCapturedRequests(stub.projectedLog),
        };
      } finally {
        await stub.close();
      }
    }

    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    if (kase.cwdFixture !== undefined) {
      const fixturePath = join(home, kase.cwdFixture.path);
      mkdirSync(dirname(fixturePath), { recursive: true });
      writeFileSync(fixturePath, kase.cwdFixture.content);
    }
    const environment: Record<string, string> = {
      ...definedEntries(process.env),
      LOHRA_NO_WIZARD: "1",
      NO_COLOR: "1",
    };
    const argv = [
      "chat",
      "--json",
      "--no-input",
      "--provider",
      options.provider,
      "--max-iterations",
      "10",
      kase.input,
    ];
    const run = await spawnCli(options.cliPath, argv, environment, home, options.timeoutMs);
    const { envelope, error } = parseEnvelope(run.stdout);
    return {
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      envelope,
      envelopeParseError: error,
      stderr: run.stderr,
      requests: [],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
