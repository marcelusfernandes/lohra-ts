// Issue #576: roda UM caso de eval — inicia o stub em processo (modo
// "stub"; `startStub` já é usado assim por
// `tests/parity/stub-lane-script.test.ts`), invoca o CLI e devolve o
// envelope e as requisições cruas capturadas para os oráculos julgarem.
//
// Invocação do CLI (issue #576, rodada 1b): por padrão, `runCli` de
// `src/cli.js` **in-process** — o mesmo padrão de `tests/local-cli.test.ts`
// — porque `npm test` roda ANTES de `npm run build` no CI
// (`tests/ci-workflow-order.test.ts`) e nenhum teste pode depender de
// `dist/`. Passar `cliPath` (CLI, `--cli <path>`) troca para um processo
// filho de verdade contra esse caminho — o modo do operador para validar o
// `dist/cli.js` empacotado depois de `npm run build`; nunca o caminho que
// `npm test`/`npm run prova` exercitam.
//
// Isolamento (AC "nunca faz rede sem --provider"): o ambiente em modo stub
// é uma allowlist literal, nunca `...process.env` — a única forma de rede
// possível é para o stub local, tanto in-process (a mesma regra vale para
// `io.environment`, que é tudo que o código de `src/` lê pelo
// `CliIo.environment`; a tool `terminal` é a EXCEÇÃO documentada — spawna
// com `env: process.env` real, não com essa allowlist, ver "Limite
// conhecido" em `docs/eval.md`, issue #607 item 1) quanto via subprocesso.
// Em modo "provider" o ambiente real É herdado de propósito (as
// credenciais vivem em `~/.lohra/.env`, fora do repo) e isso só acontece
// quando quem chama `runEvalCase` passou `--provider` explicitamente
// (`run.ts` recusa isso em CI antes de chegar aqui).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import { runCli } from "../../src/cli.js";
import { openStateForEnvironment, SessionRepository } from "../../src/state/index.js";
import { startStub } from "../stub/server.js";
import type { StubRuntime } from "../stub/types.js";
import { refuseNetworkInCi } from "./ci-guard.js";
import type { CapturedRequest, EvalCase, EvalSeedTurn } from "./types.js";

export interface EvalRunOptions {
  /** Só em modo subprocesso (operador, `--cli <path>`); ausente == in-process. */
  readonly cliPath?: string;
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

interface CliRunResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
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
): Promise<CliRunResult> {
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

/** Chama `runCli` in-process — sem subprocesso, sem `dist/`. `runCli`
 * resolve para o exit code (nunca lança para um turno que falhou; erros do
 * próprio turno já viram `errorEnvelope` no stdout, como no CLI real). O
 * `Promise.race` cobre o timeout do lado de fora: uma chamada real de
 * provedor que trava não é matável in-process (não há processo para
 * `SIGKILL`) — aceitável aqui porque o timeout (`run.ts`, 20s) é generoso e
 * todo caso de stub é determinístico e rápido; `timedOut: true` ainda marca
 * a linha de resultado corretamente mesmo que a chamada perdida siga
 * rodando em segundo plano dentro do processo do runner.
 *
 * `process.chdir` para `cwd`: as tools de arquivo (`read_file`/`write_file`)
 * e `terminal` resolvem caminho relativo contra o cwd REAL do processo do
 * SO, nunca contra `CliIo.cwd` (que só alimenta `options.cwd` de
 * `chat.ts` — descoberta de `AGENTS.md`/`CLAUDE.md`, escopo de skills de
 * projeto). Em modo subprocesso isso saía de graça (o `spawn` já dá ao
 * filho seu próprio cwd real); in-process, sem isso, um `cwd_fixture`
 * relativo (`tool-target.txt`) nunca seria encontrado. `runInProcess`
 * restaura o cwd (via `restoreProjectRootCwd`) só quando a invocação de
 * verdade se resolve — nunca dentro do `Promise.race`, que pode vencer
 * primeiro por timeout enquanto a chamada perdida segue lendo/escrevendo
 * relativo ao `cwd` do caso. `runEvalCase` (abaixo) também chama
 * `restoreProjectRootCwd` no seu próprio `finally`, então o cwd volta para
 * a raiz do processo mesmo num timeout — a chamada perdida, se ainda
 * rodar depois disso, passa a resolver caminho relativo contra a raiz do
 * projeto (não mais contra o diretório do caso, já removido); seu
 * resultado já foi descartado de qualquer forma, e a alternativa (não
 * restaurar) era `ENOENT` para TODO caso seguinte (item 7 abaixo).
 *
 * Issue #607 item 7: o alvo de restauração NUNCA é um `process.cwd()`
 * capturado de novo a cada chamada — é sempre `PROJECT_ROOT_CWD`, uma
 * única captura feita no import deste módulo. Um `previousCwd`
 * recapturado por chamada podia, sob um caso que estourasse `timeoutMs`
 * (típico de `--provider` contra rede real), ficar apontando para o
 * diretório temporário de um caso ANTERIOR já removido por `runEvalCase`
 * (que fazia `rmSync` antes de qualquer chamada de volta a
 * `process.chdir` ter rodado) — dependendo do timing e da plataforma,
 * isso derrubava o runner de duas formas possíveis, ambas eliminadas por
 * `PROJECT_ROOT_CWD`: (a) `process.cwd()` do PRÓXIMO caso lançando
 * `ENOENT` (`uv_cwd`) por rodar com o cwd ativo do processo já apontando
 * para um diretório apagado (reproduzido em
 * `tests/eval-session-internals.test.ts`), ou (b) o `previousCwd` capturado
 * daquele jeito sendo, ele mesmo, o caminho já removido, e um
 * `process.chdir(previousCwd)` tardio (dentro de um `.finally` não
 * aguardado, `void`) lançando `ENOENT` como rejeição não tratada. Em
 * qualquer um dos dois casos o runner morria no meio do lote.
 * `PROJECT_ROOT_CWD` nunca é removido pelo harness — restaurar para ele é
 * sempre seguro, independente de quantos casos rodaram (ou travaram)
 * desde então. */
const PROJECT_ROOT_CWD = process.cwd();

/** Só para teste (test-only, issue #607 item 7): `runInProcess` recebe o
 * `invoke` real (`runCli`) por padrão — nenhum chamador de produção passa
 * outro. */
export type CliInvoker = typeof runCli;

export async function runInProcess(
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
  cwd: string,
  timeoutMs: number,
  invoke: CliInvoker = runCli,
): Promise<CliRunResult> {
  let stdout = "";
  let stderr = "";
  process.chdir(cwd);
  const invocation = invoke(argv, {
    environment: { ...environment },
    cwd,
    isTty: false,
    probeOllama: () => Promise.resolve(false),
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  }).then(
    (exitCode) => ({ exitCode, timedOut: false, stdout, stderr }),
    (error: unknown) => ({
      exitCode: 1,
      timedOut: false,
      stdout,
      stderr: `${stderr}${String(error)}\n`,
    }),
  );
  void invocation.finally(() => {
    restoreProjectRootCwd();
  });
  const timeout = new Promise<CliRunResult>((resolve) => {
    setTimeout(() => {
      resolve({ exitCode: 124, timedOut: true, stdout, stderr });
    }, timeoutMs);
  });
  return Promise.race([invocation, timeout]);
}

/** Melhor esforço, nunca uma rejeição não tratada (CLAUDE.md invariante 2:
 * falha nunca silenciosa, mas também nunca fatal para o lote inteiro por
 * uma restauração de cwd que já é só limpeza). `PROJECT_ROOT_CWD` nunca
 * deveria sumir; se sumir mesmo assim, avisamos em stderr em vez de deixar
 * o processo cair. */
function restoreProjectRootCwd(): void {
  try {
    process.chdir(PROJECT_ROOT_CWD);
  } catch (error) {
    process.stderr.write(
      `eval: não foi possível restaurar o cwd para ${PROJECT_ROOT_CWD}: ${String(error)}\n`,
    );
  }
}

function definedEntries(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Ambiente do modo `--provider`: herdado do operador de propósito — as
 * credenciais vivem em `~/.lohra/.env`, fora do repo (`src/config/paths.ts`)
 * — mas SEMPRE isolado num profile próprio (issue #607 item 2). Sem isso,
 * `resolvePaths` (`src/config/paths.ts:30-39`) resolve `home` para
 * `~/.lohra` (o profile default do operador) e o baseline grava sessões no
 * MESMO `state.db` das sessões reais dele. `.env` independe de profile
 * (`envFile` é sempre `~/.lohra/.env`), então isolar o profile nunca esconde
 * as credenciais. Um `LOHRA_PROFILE` já exportado pelo operador vence — o
 * default é só para quem não escolheu nenhum, nunca uma imposição sobre uma
 * escolha explícita. */
export function buildProviderEnvironment(processEnv: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...definedEntries(processEnv),
    // `||`, não `??`: `LOHRA_PROFILE=""` exportada pelo operador não é uma
    // escolha explícita de profile (`resolvePaths`, `src/config/paths.ts`,
    // rejeita string vazia como configuração inválida) — cai no mesmo
    // default que a ausência da variável (issue #653 item 2).
    LOHRA_PROFILE: processEnv.LOHRA_PROFILE || "eval",
    LOHRA_NO_WIZARD: "1",
    NO_COLOR: "1",
  };
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

function runCliOrSpawn(
  options: EvalRunOptions,
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
  cwd: string,
): Promise<CliRunResult> {
  return options.cliPath === undefined
    ? runInProcess(argv, environment, cwd, options.timeoutMs)
    : spawnCli(options.cliPath, argv, environment, cwd, options.timeoutMs);
}

/** Seed direto no `state.db` do caso — mesmo padrão de
 * `tests/chat-compaction-events.test.ts` (`SessionRepository.recordTurn`)
 * — necessário porque `preflightCompact` (`src/conversation/runtime.ts`)
 * só encontra história para dobrar quando já existem turnos PERSISTIDOS de
 * uma sessão anterior; um turno novo nunca tem nada próprio para
 * compactar. `environment` precisa já trazer `LOHRA_PROFILE` (a mesma
 * resolução de caminho que `resolvePaths` faz dentro do `runCli`/processo
 * real, para o DB seedado aqui ser o MESMO que a chamada real abre). */
function seedSession(
  environment: Readonly<Record<string, string>>,
  sessionId: string,
  model: string,
  turns: readonly EvalSeedTurn[],
): void {
  const connection = openStateForEnvironment(environment);
  try {
    const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
    sessions.createSession({
      id: sessionId,
      model,
      systemPrompt: "eval-seed",
      cwd: environment.HOME ?? null,
    });
    for (const turn of turns) {
      sessions.recordTurn(sessionId, {
        user: { role: "user", content: turn.user },
        assistant: { role: "assistant", content: turn.assistant, finishReason: "stop" },
      });
    }
  } finally {
    connection.close();
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
  // Defesa em profundidade (rodada 2): `run.ts`'s `main()` já chama isso
  // antes de montar o lote, mas um chamador direto de `runEvalCase` (outro
  // script, um teste futuro) não passa por `main()` — a garantia "nunca
  // --provider em CI" precisa valer aqui também, não só no caminho feliz
  // do CLI.
  refuseNetworkInCi(options.provider, process.env);
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
          LOHRA_PROFILE: "eval",
          LOHRA_NO_WIZARD: "1",
          NO_COLOR: "1",
          LOHRA_PROVIDER_BASE_URL: `http://127.0.0.1:${String(stub.port)}/v1`,
          LOHRA_OLLAMA_CONNECT_URL: `http://127.0.0.1:${String(stub.port)}/api/tags`,
          ...(kase.contextWindowOverride === undefined
            ? {}
            : { LOHRA_CONTEXT_WINDOW: String(kase.contextWindowOverride) }),
        };
        const sessionArgs: string[] = [];
        if (kase.sessionSeed !== undefined && kase.sessionSeed.length > 0) {
          const sessionId = kase.id.replace(/[^a-z0-9-]/giu, "-");
          seedSession(environment, sessionId, "stub-coder:1b", kase.sessionSeed);
          sessionArgs.push("--session", sessionId);
        }
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
          ...sessionArgs,
          kase.input,
        ];
        const run = await runCliOrSpawn(options, argv, environment, home);
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
    const environment = buildProviderEnvironment(process.env);
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
    const run = await runCliOrSpawn(options, argv, environment, home);
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
    // Issue #607 item 7: restaura o cwd para a raiz do processo ANTES de
    // remover `root` — nunca a ordem inversa. Um caso que estourou
    // `timeoutMs` (`runCliOrSpawn` já retornou pelo braço do timeout) pode
    // deixar `process.cwd()` ainda dentro de `root` enquanto a chamada
    // perdida segue rodando em segundo plano (comentário de
    // `runInProcess`); sem restaurar aqui, `rmSync` apagaria o diretório
    // que ainda é o cwd ATIVO do processo antes que o `.finally` de
    // `runInProcess` tivesse a chance de rodar — o mesmo sintoma que
    // corrompia `previousCwd` de um caso seguinte (ver `PROJECT_ROOT_CWD`
    // acima). Melhor esforço: nunca deixa uma falha aqui virar exceção
    // não tratada que perderia o `rmSync` de limpeza.
    restoreProjectRootCwd();
    rmSync(root, { recursive: true, force: true });
  }
}
