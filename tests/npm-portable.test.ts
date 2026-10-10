import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveNpmCli, runNpmSync } from "../scripts/subprocess/npm.js";

function fixture(): { readonly root: string; readonly npmCli: string } {
  const root = mkdtempSync(join(tmpdir(), "lohra npm & literal "));
  const npmCli = join(root, "npm cli & literal.js");
  writeFileSync(
    npmCli,
    `process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),marker:process.env.MARKER}));
     process.exit(Number(process.env.EXIT_CODE ?? 0));`,
  );
  return { root, npmCli };
}

describe("npm portable subprocess", () => {
  it("runs npm from the active Node installation", () => {
    const result = runNpmSync(["--version"], { timeoutMs: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("resolves the npm CLI beside the current Node installation on Windows and Unix", () => {
    const { root } = fixture();
    try {
      const winNode = join(root, "windows node", "node.exe");
      const winNpm = join(dirname(winNode), "node_modules", "npm", "bin", "npm-cli.js");
      mkdirSync(dirname(winNpm), { recursive: true });
      writeFileSync(winNpm, "");
      expect(resolveNpmCli({ nodeExecutable: winNode, platform: "win32", env: {} })).toBe(winNpm);

      const unixNode = join(root, "unix node", "bin", "node");
      const unixNpm = resolve(
        dirname(unixNode),
        "..",
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      mkdirSync(dirname(unixNpm), { recursive: true });
      writeFileSync(unixNpm, "");
      expect(resolveNpmCli({ nodeExecutable: unixNode, platform: "linux", env: {} })).toBe(unixNpm);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps literal argv, cwd, env and exit status without a shell", () => {
    const { root, npmCli } = fixture();
    try {
      const argv = ["run", "a & b", "$(echo hi)", "semi;colon", "space value"];
      const result = runNpmSync(argv, {
        cwd: root,
        env: { ...process.env, npm_execpath: npmCli, MARKER: "value & $(literal)", EXIT_CODE: "7" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ argv, cwd: root, marker: "value & $(literal)" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails with a cause when explicit npm is absent, without falling back", () => {
    const { root } = fixture();
    try {
      const nodeExecutable = join(root, "node.exe");
      const siblingNpm = join(root, "node_modules", "npm", "bin", "npm-cli.js");
      mkdirSync(dirname(siblingNpm), { recursive: true });
      writeFileSync(siblingNpm, "");
      const missing = join(root, "missing npm-cli.js");
      expect(() =>
        resolveNpmCli({ nodeExecutable, platform: "win32", env: { npm_execpath: missing } }),
      ).toThrow(/NPM_CLI_NOT_FOUND/);
      try {
        resolveNpmCli({ nodeExecutable, platform: "win32", env: { npm_execpath: missing } });
      } catch (error) {
        expect((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code).toBe("ENOENT");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves spawn error and timeout signal", () => {
    const { root, npmCli } = fixture();
    try {
      const missingNode = runNpmSync([], {
        nodeExecutable: join(root, "missing node"),
        env: { ...process.env, npm_execpath: npmCli },
      });
      expect(missingNode.status).toBeNull();
      expect((missingNode.error as NodeJS.ErrnoException).code).toBe("ENOENT");

      writeFileSync(npmCli, "setTimeout(() => {}, 5000);");
      const timedOut = runNpmSync([], {
        env: { ...process.env, npm_execpath: npmCli },
        timeoutMs: 100,
      });
      expect(timedOut.status).toBeNull();
      expect(timedOut.signal).toBe("SIGTERM");
      expect((timedOut.error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
