// Issue #213: `scripts/pack-check.ts:135` declarava `expectedResult` como
// `'{"ok": true, "bytes_written": 10, "path": "package-written/out.txt"}'`
// (com espaços depois dos dois-pontos) e comparava por igualdade de string
// contra a serialização compacta do runtime (`stringifyJsonPreservingNumbers`
// — `src/tools/envelope.ts`), então `npm run pack:check` reprovava com
// `PACK_CHAT_MISMATCH` mesmo com o chat correto (evidência na PR #212).
//
// `assertStructuralMatch` e `extractLastToolResultContent` são puras — a
// primeira faz `JSON.parse` dos dois lados e nunca compara strings
// literalmente; a segunda lê o `projected` log (JSONL de
// `scripts/stub/server.ts`) já em memória, sem depender de `npm pack`. Isso
// é o que permite este arquivo provar o comportamento sem rodar o pipeline
// caro (`npm run pack:check`, que continua sendo a prova de ponta a ponta,
// colada manualmente no test plan da PR).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertNoNativeCompileNeeded,
  assertStructuralMatch,
  extractLastToolResultContent,
} from "../scripts/pack-check.js";

const COMPACT = '{"ok":true,"bytes_written":10,"path":"package-written/out.txt"}';
// A forma exatamente como estava hardcoded na issue — com espaços — prova
// que a comparação agora é imune à formatação, não só ao valor.
const SPACED = '{"ok": true, "bytes_written": 10, "path": "package-written/out.txt"}';

describe("assertStructuralMatch", () => {
  it("não lança quando os dois lados são estruturalmente iguais, mesmo com formatação diferente", () => {
    expect(() => {
      assertStructuralMatch(SPACED, COMPACT);
    }).not.toThrow();
  });

  it("lança PACK_CHAT_MISMATCH nomeando o campo divergente quando um valor diverge", () => {
    const divergent = '{"ok":true,"bytes_written":999,"path":"package-written/out.txt"}';
    expect(() => {
      assertStructuralMatch(SPACED, divergent);
    }).toThrow(/PACK_CHAT_MISMATCH.*bytes_written/);
  });

  it("lança PACK_CHAT_MISMATCH com uma causa nomeada quando o lado atual não é JSON válido", () => {
    expect(() => {
      assertStructuralMatch(SPACED, "não é json");
    }).toThrow(/PACK_CHAT_MISMATCH/);
  });
});

describe("extractLastToolResultContent", () => {
  it("devolve o content da mensagem role:tool da última requisição do log", () => {
    const log = [
      JSON.stringify({
        seq: 1,
        body: { messages: [{ role: "system" }, { role: "user" }] },
      }),
      JSON.stringify({
        seq: 2,
        body: {
          messages: [
            { role: "system" },
            { role: "user" },
            { role: "assistant" },
            { role: "tool", tool_call_id: "call_1", content: COMPACT },
          ],
        },
      }),
    ].join("\n");
    expect(extractLastToolResultContent(log)).toBe(COMPACT);
  });

  it("devolve null quando nenhuma requisição tem mensagem role:tool", () => {
    const log = JSON.stringify({
      seq: 1,
      body: { messages: [{ role: "system" }, { role: "user" }] },
    });
    expect(extractLastToolResultContent(log)).toBeNull();
  });

  it("ignora linhas vazias, mas lança numa linha não vazia que não é JSON válido", () => {
    // O log é escrito em processo por scripts/stub/server.ts via
    // JSON.stringify; uma linha não vazia corrompida é o próprio stub
    // quebrado, não uma entrada normal a pular em silêncio.
    const log = ["", "não é json", ""].join("\n");
    expect(() => {
      extractLastToolResultContent(log);
    }).toThrow(/PACK_CHAT_MISMATCH.*projected_log/);
  });
});

// Issue #532: `assertNoNativeCompileNeeded` não roda `npm ci` nem toca rede
// — recebe um `consumerRoot` fabricado com `mkdtempSync` e confere só a
// árvore de arquivos, exatamente como um `node_modules` de consumidor real
// ficaria depois da instalação (prebuilt ou compilado). `platform`/`arch`
// são injetados (nunca lidos de `process.*` dentro da função) para o teste
// rodar em qualquer máquina e ainda provar o caminho de outra plataforma
// (ex.: `linux-x64` rodando em macOS) — é a própria alegação de
// portabilidade em forma de teste.
function writeFile(root: string, relativePath: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, "");
}

function betterSqlite3Binary(root: string): void {
  writeFile(
    root,
    join("node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
  );
}

function nodePtyBinary(root: string, platform: string, arch: string): void {
  writeFile(root, join("node_modules", "node-pty", "prebuilds", `${platform}-${arch}`, "pty.node"));
}

describe("assertNoNativeCompileNeeded", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("lança PACK_NATIVE_PREBUILD_MISSING nomeando better-sqlite3 quando o binário não existe no consumidor", () => {
    root = mkdtempSync(join(tmpdir(), "lohra-pack-native-"));
    nodePtyBinary(root, "linux", "x64");
    expect(() => {
      assertNoNativeCompileNeeded({ consumerRoot: root as string, platform: "linux", arch: "x64" });
    }).toThrow(/PACK_NATIVE_PREBUILD_MISSING:better-sqlite3/);
  });

  it("lança PACK_NATIVE_PREBUILD_MISSING nomeando node-pty quando não há prebuild para a plataforma/arquitetura pedida", () => {
    root = mkdtempSync(join(tmpdir(), "lohra-pack-native-"));
    betterSqlite3Binary(root);
    nodePtyBinary(root, "darwin", "arm64"); // existe, mas para outra plataforma
    expect(() => {
      assertNoNativeCompileNeeded({ consumerRoot: root as string, platform: "linux", arch: "x64" });
    }).toThrow(/PACK_NATIVE_PREBUILD_MISSING:node-pty/);
  });

  it("lança PACK_NATIVE_COMPILED_FROM_SOURCE nomeando o módulo quando node-gyp gerou config.gypi", () => {
    root = mkdtempSync(join(tmpdir(), "lohra-pack-native-"));
    betterSqlite3Binary(root);
    nodePtyBinary(root, "linux", "x64");
    // node-gyp configure escreve build/config.gypi antes de compilar
    // qualquer coisa — mesmo que o .node resultante exista, é sinal de que
    // o fallback nativo rodou em vez do prebuild.
    writeFile(root, join("node_modules", "better-sqlite3", "build", "config.gypi"));
    expect(() => {
      assertNoNativeCompileNeeded({ consumerRoot: root as string, platform: "linux", arch: "x64" });
    }).toThrow(/PACK_NATIVE_COMPILED_FROM_SOURCE:better-sqlite3/);
  });

  it("não lança quando os dois prebuilds existem para a plataforma/arquitetura pedida e nenhum node-gyp rodou", () => {
    root = mkdtempSync(join(tmpdir(), "lohra-pack-native-"));
    betterSqlite3Binary(root);
    nodePtyBinary(root, "linux", "x64");
    expect(() => {
      assertNoNativeCompileNeeded({ consumerRoot: root as string, platform: "linux", arch: "x64" });
    }).not.toThrow();
  });
});

// Issue #549: `node-pty@1.1.0` (o pin anterior) só publica prebuilds
// `darwin-*`/`win32-*` — nunca `linux-x64`/`linux-arm64`, nem embutidos no
// tarball nem via rede (`scripts/prebuild.js` do próprio pacote só confere
// se `prebuilds/<platform>-<arch>` já existe localmente; nunca baixa nada).
// Investigação (`npm pack node-pty@<v> --pack-destination <mkdtemp>` +
// listagem de `prebuilds/` no tarball, candidatas inspecionadas: `1.1.0`,
// `1.2.0-beta.1`, `1.2.0-beta.8`, `1.2.0-beta.15`) mostrou
// `linux-x64`/`linux-arm64` ausentes em `1.1.0` e `1.2.0-beta.1`, presentes
// em `1.2.0-beta.8` e em `1.2.0-beta.15` — a mais recente disponível hoje e a
// escolhida para o pin (nenhuma versão estável ≥1.1.0 publica prebuild
// Linux; não houve bisseção entre `beta.2` e `beta.7`). A API usada por
// `src/tools/terminal.ts` (`spawn`/`onData`/`onExit`/`kill`) é idêntica
// entre `1.1.0` e `1.2.0-beta.15` (typings/node-pty.d.ts, comparação
// manual). Este teste prende a versão pinada — não a resolução do npm —
// para uma reversão futura para `1.1.0` (ou qualquer versão sem prebuild
// Linux) reprovar aqui antes de `npm run pack:check` gastar tempo
// compilando.
describe("pin de node-pty (prebuilds Linux)", () => {
  it("dependencies.node-pty é 1.2.0-beta.15 (última candidata inspecionada com prebuilds linux-x64/linux-arm64)", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    expect(manifest.dependencies?.["node-pty"]).toBe("1.2.0-beta.15");
  });
});
