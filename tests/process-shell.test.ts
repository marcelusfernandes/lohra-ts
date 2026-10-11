import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProcessShellLaunchError,
  resolveProcessShell,
  spawnProcessShell,
} from "./helpers/process-shell.js";

describe("shell das bancadas de processo", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "process-shell-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lança o shell real e preserva stdout, stderr e status", () => {
    const result = spawnProcessShell(["-c", "printf out; printf err >&2"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("preserva stdin, cwd e ambiente sem mutar o objeto do chamador", () => {
    const cwd = path.join(root, "diretório com espaços");
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, "marker"), "arquivo");
    const env = { ...process.env, TEST_MARKER: "ambiente" };
    const snapshot = { ...env };
    const result = spawnProcessShell(
      [
        "-c",
        'read line; printf "%s:%s:" "$line" "$TEST_MARKER"; cat marker; printf aviso >&2; exit 7',
      ],
      { cwd, input: "entrada\n", env, encoding: "utf8" },
    );
    expect(result.status).toBe(7);
    expect(result.stdout).toBe("entrada:ambiente:arquivo");
    expect(result.stderr).toBe("aviso");
    expect(env).toEqual(snapshot);
  });

  it("identifica o shell a partir de um diretório com espaços, sem drive fixo", () => {
    const prefix = path.join(root, "git com espaços");
    const bin = path.join(prefix, "bin");
    mkdirSync(bin, { recursive: true });
    const shell = path.join(bin, process.platform === "win32" ? "sh.exe" : "sh");
    writeFileSync(shell, "fixture");
    if (process.platform === "win32") {
      const cmd = path.join(prefix, "cmd");
      mkdirSync(cmd);
      writeFileSync(path.join(cmd, "git.exe"), "fixture");
      expect(resolveProcessShell({ Path: path.join(root, "sem-shell"), PATH: cmd })).toBe(shell);
    } else {
      expect(resolveProcessShell({ PATH: bin })).toBe(shell);
    }
  });

  it("executa caminho absoluto com espaços sem camada extra de shell", () => {
    const bin = path.join(root, "bin com espaços");
    mkdirSync(bin);
    const nodeCopy = path.join(bin, path.basename(process.execPath));
    copyFileSync(process.execPath, nodeCopy);
    if (process.platform !== "win32") chmodSync(nodeCopy, 0o755);
    const result = spawnProcessShell(
      ["-e", "process.stdout.write('espaços')"],
      { encoding: "utf8" },
      nodeCopy,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("espaços");
  });

  it("preserva a precedência do PATH do chamador diante do diretório do shell", () => {
    const preferredDir = path.join(root, "shim prioritário");
    const shellDir = path.join(root, "shell com concorrente");
    mkdirSync(preferredDir);
    mkdirSync(shellDir);
    const executable = process.platform === "win32" ? "gh.exe" : "gh";
    const preferred = path.join(preferredDir, executable);
    const competing = path.join(shellDir, executable);
    const shell = path.join(shellDir, path.basename(process.execPath));
    for (const target of [preferred, competing, shell]) {
      symlinkSync(process.execPath, target, "file");
    }

    const env = {
      ...process.env,
      PATH: `${preferredDir}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const result = spawnProcessShell(
      [
        "-e",
        "const {spawnSync}=require('node:child_process');const r=spawnSync('gh',['-e','process.stdout.write(process.execPath)'],{encoding:'utf8'});process.stdout.write(JSON.stringify({status:r.status,stdout:r.stdout,error:r.error?.code}))",
      ],
      { encoding: "utf8", env },
      shell,
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: 0, stdout: preferred });
  });

  it("shell ausente preserva ENOENT como causa explícita", () => {
    const emptyPath = path.join(root, "vazio");
    mkdirSync(emptyPath);
    expect(() => resolveProcessShell({ PATH: emptyPath })).toThrow(ProcessShellLaunchError);
    const missing = path.join(root, "ausente", "sh");
    expect(() => spawnProcessShell(["-c", "printf x"], { encoding: "utf8" }, missing)).toThrow(
      ProcessShellLaunchError,
    );
    try {
      spawnProcessShell(["-c", "printf x"], { encoding: "utf8" }, missing);
    } catch (error) {
      expect(error).toMatchObject({ status: null, cause: { code: "ENOENT" } });
    }
  });

  it("falha de inspeção do shell preserva a causa em vez de virar ausência", () => {
    const invalidPath = path.join(root, "invalid\0path");
    try {
      resolveProcessShell({ PATH: invalidPath });
      throw new Error("a inspeção deveria falhar");
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessShellLaunchError);
      expect(error).toMatchObject({ cause: { code: "ERR_INVALID_ARG_VALUE" } });
    }
  });
});
