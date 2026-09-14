import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalManager,
  isUntrustedPath,
  parseToolArguments,
  readFileTool,
  terminalTool,
  writeFileTool,
} from "../src/tools/index.js";

const roots: string[] = [];
const root = (): string => {
  const path = mkdtempSync(join(tmpdir(), "lohra-tools-"));
  roots.push(path);
  return path;
};

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("filesystem tools", () => {
  it("reads UTF-8 and truncates at 100,000 Unicode code points", () => {
    const path = join(root(), "astral.txt");
    writeFileSync(path, "😀".repeat(100_001));
    const result = JSON.parse(readFileTool({ path })) as {
      data: string;
      truncated: boolean;
      path: string;
    };
    expect(result.truncated).toBe(true);
    expect(Array.from(result.data)).toHaveLength(100_000);
    expect(result.data).toHaveLength(200_000);
    expect(result.path).toBe(path);
  });

  it("distinguishes missing, directory, and invalid UTF-8 inputs", () => {
    const directory = root();
    expect(readFileTool({})).toBe('{"error":"missing required argument \'path\'"}');
    expect(readFileTool({ path: join(directory, "missing") })).toContain("file not found:");
    expect(readFileTool({ path: directory })).toContain("path is a directory:");
    const binary = join(directory, "binary");
    writeFileSync(binary, Buffer.from([0xff, 0xfe]));
    expect(readFileTool({ path: binary })).toContain("file is not valid UTF-8 text:");
  });

  // Issue #581 (épico #575, P5): um caminho fora do project_root (aqui, um
  // diretório sob os.tmpdir(), sem `.git`/`package.json` acima dele até a
  // raiz — nunca ancestral do cwd real do processo de teste, a raiz deste
  // worktree) é dado potencialmente de terceiro — o envelope carrega
  // `untrusted: true`, campo aditivo (ADR de wire format próprio, chave
  // nunca presente para o caso comum de um caminho dentro do projeto).
  it("marks untrusted a path outside project_root", () => {
    const path = join(root(), "outside.txt");
    writeFileSync(path, "conteúdo de fora");
    const result = JSON.parse(readFileTool({ path })) as {
      data: string;
      untrusted?: boolean;
    };
    expect(result.data).toBe("conteúdo de fora");
    expect(result.untrusted).toBe(true);
  });

  it("omits 'untrusted' entirely for a path inside project_root", () => {
    const path = join(process.cwd(), "package.json");
    const result = JSON.parse(readFileTool({ path })) as Record<string, unknown>;
    expect("untrusted" in result).toBe(false);
  });

  // Issue #642: `isUntrustedPath` media com `resolve()`, que não segue
  // symlink — um symlink DENTRO do projeto apontando para fora do
  // project_root era lido como confiável. `realOrResolved` (mesma régua de
  // `src/skills/store.ts`) resolve o caminho real antes de medir a
  // fronteira.
  it("marks untrusted a symlink under project_root pointing outside of it (#642)", () => {
    const outsideTarget = join(root(), "outside.txt");
    writeFileSync(outsideTarget, "conteúdo de fora");
    const linkDir = mkdtempSync(join(process.cwd(), "lohra-symlink-out-"));
    roots.push(linkDir);
    const link = join(linkDir, "link.txt");
    symlinkSync(outsideTarget, link);
    const result = JSON.parse(readFileTool({ path: link })) as { untrusted?: boolean };
    expect(result.untrusted).toBe(true);
  });

  // Contra-caso: um symlink FORA do projeto (em tmp) apontando para um
  // arquivo DENTRO do project_root não pode virar "untrusted" só porque o
  // caminho literal do link mora fora — a régua é o arquivo real, não o
  // link.
  it("omits 'untrusted' for a symlink outside project_root pointing inside it (#642)", () => {
    const linkDir = root();
    const link = join(linkDir, "link-to-package-json");
    symlinkSync(join(process.cwd(), "package.json"), link);
    const result = JSON.parse(readFileTool({ path: link })) as Record<string, unknown>;
    expect("untrusted" in result).toBe(false);
  });

  // Issue #670 (residual F3, veredito PR #655 item 4): `realOrResolved`
  // fail-OPEN em qualquer erro não-`ENOENT` (`realpathSync` lança, o
  // `catch` devolve `resolve(path)` — que não segue symlink e não prova
  // nada sobre a fronteira). Um ciclo de symlinks DENTRO do projeto faz
  // `realpathSync` lançar `ELOOP`; o caminho real não pode ser
  // estabelecido, então a fronteira tem que fechar (`untrusted: true`),
  // nunca abrir por engano. `read_file` em si não prova isso: `readFileSync`
  // lança ELOOP antes de `isUntrustedPath` rodar (a leitura em si já
  // falha) — por isso o teste chama `isUntrustedPath` direto, como
  // `readFileTool` chamaria internamente.
  it("isUntrustedPath fails closed (untrusted) when the boundary can't be resolved (ELOOP cycle, #670)", () => {
    // realpathSync on the root itself (macOS: os.tmpdir() often lives
    // behind its own symlink, e.g. /var/folders/... -> /private/var/...) —
    // otherwise the canonicalization gap between root and path alone would
    // already read as "outside", true on both the old and the fixed code,
    // proving nothing about the ELOOP fail-open/fail-closed distinction.
    const dir = realpathSync(root());
    const a = join(dir, "a");
    const b = join(dir, "b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(isUntrustedPath(a, dir)).toBe(true);
  });

  it("writes parent directories, UTF-8 bytes, and validates content", () => {
    const path = join(root(), "sub", "out.txt");
    expect(writeFileTool({ path, content: "café 😀" })).toBe(
      `{"ok":true,"bytes_written":10,"path":"${path}"}`,
    );
    expect(readFileSync(path, "utf8")).toBe("café 😀");
    expect(writeFileTool({ path })).toBe('{"error":"missing required argument \'content\'"}');
    expect(writeFileTool({ path, content: 1 })).toBe('{"error":"\'content\' must be a string"}');
  });
});

describe("terminal tool", () => {
  it("returns stdout, stderr and nonzero exits", async () => {
    const approval = new ApprovalManager();
    const result = JSON.parse(
      await terminalTool(
        { command: "printf out; printf err >&2; exit 7" },
        { approvalManager: approval },
      ),
    ) as { stdout: string; stderr: string; exit_code: number };
    expect(result).toEqual({ ok: true, stdout: "out", stderr: "err", exit_code: 7 });
  });

  it("gates dangerous commands before execution", async () => {
    const directory = root();
    const sentinel = join(directory, "sentinel");
    const command = `sudo touch ${sentinel}`;
    expect(await terminalTool({ command }, { approvalManager: new ApprovalManager() })).toBe(
      `{"error":"command refused by the dangerous-command policy (elevated privileges (sudo))",` +
        `"command":"${command}","refusal":"final"}`,
    );
    expect(() => readFileSync(sentinel)).toThrow();
  });

  it.each([
    ['{"command":"sleep 4","timeout":1}', "1s"],
    ['{"command":"sleep 4","timeout":1.0}', "1.0s"],
    ['{"command":"sleep 4","timeout":2.50}', "2.5s"],
    ['{"command":"sleep 4","timeout":1e0}', "1.0s"],
    ['{"command":"sleep 4","timeout":true}', "trues"],
    ['{"command":"sleep 4","timeout":0}', "0s"],
  ])("renders Python timeout semantics for %s", async (raw, rendered) => {
    const args = parseToolArguments(raw);
    const result = await terminalTool(args, { approvalManager: new ApprovalManager() });
    expect(result).toContain(`command timed out after ${rendered}`);
  });

  it("treats null timeout as disabled", async () => {
    const result = JSON.parse(
      await terminalTool(parseToolArguments('{"command":"printf ok","timeout":null}'), {
        approvalManager: new ApprovalManager(),
      }),
    ) as { stdout: string };
    expect(result.stdout).toBe("ok");
  });

  it("truncates each stream by code point", async () => {
    const directory = root();
    const script = join(directory, "emit.mjs");
    writeFileSync(
      script,
      'process.stdout.write("😀".repeat(50001)); process.stderr.write("😀".repeat(50001));',
    );
    const result = JSON.parse(
      await terminalTool(
        { command: `node ${JSON.stringify(script)}` },
        { approvalManager: new ApprovalManager() },
      ),
    ) as { stdout: string; stderr: string };
    expect(Array.from(result.stdout)).toHaveLength(50_000);
    expect(Array.from(result.stderr)).toHaveLength(50_000);
    expect(result.stdout).toHaveLength(100_000);
    expect(result.stderr).toHaveLength(100_000);
  });

  it("validates command type before the gate", async () => {
    const directory = root();
    mkdirSync(join(directory, "kept"));
    expect(await terminalTool({ command: ["sudo", "x"] })).toBe(
      '{"error":"missing required argument \'command\' (string)"}',
    );
  });
});
