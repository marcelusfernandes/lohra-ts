#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { startStub } from "./stub/server.js";
import type { StubRuntime } from "./stub/types.js";
import { prepareOfflineTarballConsumer } from "./offline-tarball-install.js";

/**
 * Issue #532: verifica que a instalação do consumidor usou os binários
 * nativos PREBUILT de `better-sqlite3`/`node-pty` — nunca compilou via
 * `node-gyp` (o fallback dos dois quando não há prebuild para a
 * plataforma/arquitetura, que exige compilador/Python na máquina do
 * consumidor e contraria "instala sem toolchain nativo", a User Story da
 * issue).
 *
 * Mecanismo escolhido — o mais simples que não depende de capturar
 * stdout/stderr de um subprocesso nem de variáveis de ambiente que os dois
 * pacotes talvez nem leiam: `node-gyp configure` sempre escreve
 * `build/config.gypi` antes de compilar qualquer coisa — é o primeiro
 * artefato que ele produz. Nem `prebuild-install` (usado por
 * `better-sqlite3`) nem `node scripts/prebuild.js` (usado por `node-pty`,
 * que só confere localmente se `prebuilds/<platform>-<arch>` existe — nunca
 * baixa nada da rede nem toca em `build/`) escrevem esse arquivo. A
 * presença de `config.gypi` é portanto prova de que o fallback nativo
 * rodou, **independente** de a compilação ter terminado com sucesso — por
 * isso ela é conferida ANTES do binário: um `.node` compilado com sucesso
 * não deixa de ser "compilou nativo" só porque funciona.
 *
 * `platform`/`arch` são parâmetros (nunca lidos de `process.*` aqui dentro)
 * para a função ser pura e testável para qualquer combinação a partir de
 * qualquer máquina — quem chama em produção (`main`, abaixo) passa
 * `process.platform`/`process.arch` de verdade.
 */
type NativeModuleCheck = {
  readonly module: string;
  readonly prebuiltBinary: (platform: string, arch: string) => string;
  readonly compiledMarker: string;
};

const NATIVE_MODULE_CHECKS: readonly NativeModuleCheck[] = [
  {
    module: "better-sqlite3",
    prebuiltBinary: () =>
      join("node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    compiledMarker: join("node_modules", "better-sqlite3", "build", "config.gypi"),
  },
  {
    module: "node-pty",
    prebuiltBinary: (platform, arch) =>
      join("node_modules", "node-pty", "prebuilds", `${platform}-${arch}`, "pty.node"),
    compiledMarker: join("node_modules", "node-pty", "build", "config.gypi"),
  },
];

export function assertNoNativeCompileNeeded(options: {
  readonly consumerRoot: string;
  readonly platform: string;
  readonly arch: string;
}): void {
  for (const check of NATIVE_MODULE_CHECKS) {
    const compiledMarker = join(options.consumerRoot, check.compiledMarker);
    if (existsSync(compiledMarker)) {
      throw new Error(`PACK_NATIVE_COMPILED_FROM_SOURCE:${check.module}`);
    }
    const prebuiltBinary = join(
      options.consumerRoot,
      check.prebuiltBinary(options.platform, options.arch),
    );
    if (!existsSync(prebuiltBinary)) {
      throw new Error(`PACK_NATIVE_PREBUILD_MISSING:${check.module}`);
    }
  }
}

function command(
  executable: string,
  argv: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(executable, [...argv], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `PACK_COMMAND_FAILED:${executable}:${String(result.status ?? result.signal ?? "unknown")}:${result.stderr}`,
    );
  return result;
}

async function commandAsync(
  executable: string,
  argv: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return await new Promise<{ readonly stdout: string; readonly stderr: string }>(
    (resolveCommand, reject) => {
      const child = spawn(executable, [...argv], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 15_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolveCommand({ stdout, stderr });
        else
          reject(
            new Error(
              `PACK_COMMAND_FAILED:${executable}:${String(code ?? signal ?? "unknown")}:${stderr}`,
            ),
          );
      });
    },
  );
}

/** Igualdade estrutural recursiva — nunca `JSON.stringify(a) === JSON.stringify(b)`
 * (ordem de chaves não importa) nem comparação de string. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function parseJsonRecord(json: string, side: "expected" | "actual"): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`PACK_CHAT_MISMATCH:tool_result.${side}_invalid_json`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`PACK_CHAT_MISMATCH:tool_result.${side}_not_object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Issue #213: compara `expectedJson` (o resultado esperado da tool, como
 * `write_file` devolve) com `actualJson` (o que realmente trafegou na
 * mensagem `role: "tool"`) por igualdade estrutural (`JSON.parse` dos dois
 * lados + comparação profunda) — nunca por igualdade de string.
 * `scripts/stub/server.ts:364` já faz uma comparação de string exata quando
 * `validation: "exact"`, mas esse arquivo não está nos `Files` desta issue;
 * por isso `main()` passa `validation: "skip"` para aquele caminho e faz a
 * comparação de verdade aqui, depois que o turno completa. Lança com o
 * campo divergente nomeado — nunca uma falha silenciosa (CLAUDE.md,
 * invariante 2).
 */
export function assertStructuralMatch(expectedJson: string, actualJson: string): void {
  const expected = parseJsonRecord(expectedJson, "expected");
  const actual = parseJsonRecord(actualJson, "actual");
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    if (!deepEqual(expected[key], actual[key])) {
      throw new Error(`PACK_CHAT_MISMATCH:tool_result.${key}`);
    }
  }
}

function toolMessageContent(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record.role !== "tool") return null;
  return typeof record.content === "string" ? record.content : null;
}

function messagesOf(logEntry: unknown): readonly unknown[] {
  if (typeof logEntry !== "object" || logEntry === null) return [];
  const body = (logEntry as Record<string, unknown>).body;
  if (typeof body !== "object" || body === null) return [];
  const messages = (body as Record<string, unknown>).messages;
  return Array.isArray(messages) ? messages : [];
}

/**
 * Lê o `projected` log (JSONL de `scripts/stub/server.ts`, uma linha por
 * requisição) e devolve o `content` da última mensagem `role: "tool"` vista
 * em qualquer requisição — ou `null` se nenhuma requisição tiver mensagem
 * `role: "tool"`. Pura: recebe o texto do log, não o caminho do arquivo,
 * para o teste não depender de I/O nem de rodar `npm pack`. Linha vazia é
 * ignorada (é só o `\n` final do arquivo); linha não vazia que não é JSON
 * válido lança — o log é escrito em processo por `scripts/stub/server.ts`
 * via `JSON.stringify`, então uma linha corrompida é o próprio stub
 * quebrado, não uma entrada normal a pular em silêncio (CLAUDE.md,
 * invariante 2).
 */
export function extractLastToolResultContent(projectedLogJsonl: string): string | null {
  let last: string | null = null;
  for (const line of projectedLogJsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      throw new Error("PACK_CHAT_MISMATCH:projected_log.invalid_line");
    }
    for (const message of messagesOf(entry)) {
      const content = toolMessageContent(message);
      if (content !== null) last = content;
    }
  }
  return last;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lohra-t09-pack-"));
  let server: Awaited<ReturnType<typeof startStub>> | undefined;
  try {
    const packDirectory = join(root, "pack");
    const installDirectory = join(root, "install");
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(packDirectory, { recursive: true });
    mkdirSync(installDirectory, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });

    const packed = command("npm", ["pack", "--json", "--pack-destination", packDirectory]);
    const packResult = JSON.parse(packed.stdout) as readonly { filename: string }[];
    const filename = packResult[0]?.filename;
    if (filename === undefined) throw new Error("PACK_TARBALL_MISSING");
    const tarball = join(packDirectory, filename);
    prepareOfflineTarballConsumer({ project: process.cwd(), consumer: installDirectory, tarball });
    command("npm", ["ci", "--offline", "--no-audit", "--no-fund"], {
      cwd: installDirectory,
      env: {
        ...process.env,
        npm_config_offline: "true",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "",
      },
    });

    const projected = join(root, "requests.jsonl");
    const raw = join(root, "requests-raw.jsonl");
    const expectedWriteResult = {
      ok: true,
      bytes_written: 10,
      path: "package-written/out.txt",
    };
    const runtime: StubRuntime = {
      fixture: "chat-tool-sequence",
      state: "up-with-models",
      scenario: "t09-package-smoke",
      side: "candidate",
      comparedHeaders: [
        "authorization",
        "accept",
        "content-type",
        "host",
        "x-stainless-retry-count",
      ],
      excludedHeaders: [
        "accept-encoding",
        "connection",
        "content-length",
        "user-agent",
        "x-stainless-lang",
        "x-stainless-package-version",
        "x-stainless-os",
        "x-stainless-arch",
        "x-stainless-runtime",
        "x-stainless-runtime-version",
        "x-stainless-async",
        "x-stainless-read-timeout",
      ],
      projectedLog: projected,
      rawLog: raw,
      failures: [],
      sequence: [],
      toolSequence: [
        {
          calls: [
            {
              name: "write_file",
              argumentsRaw: '{"path":"package-written/out.txt","content":"package-ok"}',
              expectedResult: JSON.stringify(expectedWriteResult),
              // scripts/stub/server.ts:364 compara este campo por igualdade
              // de string exata quando validation !== "skip" — esse arquivo
              // não está nos Files da #213. A comparação de verdade (#213:
              // estrutural, com o campo divergente nomeado) acontece abaixo,
              // via assertStructuralMatch, depois que o turno completa.
              validation: "skip",
            },
          ],
        },
      ],
      laneSteps: {},
      laneStepIndex: new Map(),
      latches: new Map(),
      posts: 0,
      requests: 0,
    };
    server = await startStub(runtime, 0);
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("PACK_STUB_ADDRESS_MISSING");
    const bin = resolve(installDirectory, "node_modules/.bin/lohra");
    if (!existsSync(bin)) throw new Error("PACK_BIN_MISSING");
    const isolatedEnvironment: NodeJS.ProcessEnv = {
      PATH: `${dirname(process.execPath)}:/bin`,
      HOME: home,
      LOHRA_HOME: join(home, ".lohra"),
      CODEX_HOME: join(home, "codex"),
      TMPDIR: join(home, "tmp"),
      TZ: "UTC",
      NO_COLOR: "1",
      COLUMNS: "80",
      LOHRA_NO_WIZARD: "1",
      LOHRA_PROVIDER_BASE_URL: `http://127.0.0.1:${String(address.port)}/v1`,
    };
    const version = command(bin, ["--version"], { cwd: project, env: isolatedEnvironment });
    if (version.stdout !== "lohra 0.0.11\n") throw new Error("PACK_VERSION_MISMATCH");
    const turn = await commandAsync(
      bin,
      ["chat", "package smoke", "--json", "--provider", "ollama", "--model", "stub-coder:1b"],
      { cwd: project, env: isolatedEnvironment },
    );
    const envelope = JSON.parse(turn.stdout) as { completed?: unknown };
    const sideEffect = join(project, "package-written", "out.txt");
    const projectedLogContent = readFileSync(projected, "utf8");
    const actualToolResult = extractLastToolResultContent(projectedLogContent);
    if (actualToolResult === null) throw new Error("PACK_CHAT_MISMATCH:tool_result.missing");
    assertStructuralMatch(JSON.stringify(expectedWriteResult), actualToolResult);
    if (envelope.completed !== true) throw new Error("PACK_CHAT_MISMATCH:completed");
    if (runtime.posts !== 2) throw new Error(`PACK_CHAT_MISMATCH:posts=${String(runtime.posts)}`);
    if (runtime.failures.length > 0) {
      throw new Error(`PACK_CHAT_MISMATCH:failures=${runtime.failures.join(",")}`);
    }
    if (!existsSync(sideEffect)) throw new Error("PACK_CHAT_MISMATCH:side_effect_missing");
    if (readFileSync(sideEffect, "utf8") !== "package-ok") {
      throw new Error("PACK_CHAT_MISMATCH:side_effect_content");
    }
    if (projectedLogContent.length === 0) throw new Error("PACK_REQUEST_LOG_EMPTY");
    process.stdout.write(
      `${JSON.stringify({ packed: true, version: true, publicTurn: true, sideEffect: true, pythonOnPath: false, posts: runtime.posts })}\n`,
    );
  } finally {
    if (server !== undefined) {
      const activeServer = server;
      await new Promise<void>((resolveClose, reject) => {
        activeServer.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        });
        activeServer.closeAllConnections();
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
}

// Só roda `main()` quando este arquivo é o entry point (`tsx
// scripts/pack-check.ts`, via `npm run pack:check`) — nunca quando um teste
// importa `assertStructuralMatch`/`extractLastToolResultContent`
// diretamente, o que rodaria `npm pack` de verdade (mesmo idioma de
// scripts/provenance/check-ancestry.ts).
function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  await main();
}
