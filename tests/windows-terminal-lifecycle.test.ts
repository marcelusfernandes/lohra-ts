import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ApprovalManager } from "../src/tools/approval.js";
import { terminalTool } from "../src/tools/terminal.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntilGone(pids: readonly number[]): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (pids.every((pid) => !isAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe("Windows terminal lifecycle", () => {
  it.skipIf(process.platform !== "win32")(
    "lets a subprocess using the real terminal tool exit naturally after a completed command",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "lohra-terminal-lifecycle-"));
      try {
        const moduleUrl = pathToFileURL(join(process.cwd(), "src/tools/terminal.ts")).href;
        const approvalUrl = pathToFileURL(join(process.cwd(), "src/tools/approval.ts")).href;
        const script = join(workspace, "run-tool.mjs");
        writeFileSync(
          script,
          `const { terminalTool } = await import(${JSON.stringify(moduleUrl)});\n` +
            `const { ApprovalManager } = await import(${JSON.stringify(approvalUrl)});\n` +
            `const result = await terminalTool({ command: "echo OUT" }, ` +
            `{ approvalManager: new ApprovalManager() });\n` +
            `console.log("TOOL_RESPONSE=" + result);\n`,
        );
        const observed = await new Promise<{
          code: number | null;
          timedOut: boolean;
          stdout: string;
          stderr: string;
        }>((resolve, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", script], {
            cwd: process.cwd(),
            env: { ...process.env, TEMP: workspace, TMP: workspace },
            windowsHide: true,
          });
          let stdout = "";
          let stderr = "";
          let timedOut = false;
          child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
          }, 7_000);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, timedOut, stdout, stderr });
          });
        });
        expect(observed.timedOut).toBe(false);
        expect(observed.code).toBe(0);
        expect(observed.stderr).toBe("");
        expect(observed.stdout).toContain('TOOL_RESPONSE={"ok":true,"stdout":"OUT');
        expect(observed.stdout.match(/TOOL_RESPONSE=/g)).toHaveLength(1);
        expect(readdirSync(workspace).filter((name) => name.startsWith("lohra-terminal-"))).toEqual(
          [],
        );
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    12_000,
  );

  it.skipIf(process.platform !== "win32")(
    "times out a command started by the tool and terminates its own child and grandchild",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "lohra-terminal-tree-"));
      const pidsPath = join(workspace, "pids.json");
      let ownPids: number[] = [];
      try {
        vi.stubEnv("TEMP", workspace);
        vi.stubEnv("TMP", workspace);
        const grandchild = join(workspace, "grandchild.cjs");
        const child = join(workspace, "child.cjs");
        writeFileSync(grandchild, "setInterval(() => {}, 1000);\n");
        writeFileSync(
          child,
          `const { spawn } = require("node:child_process");\n` +
            `const { writeFileSync } = require("node:fs");\n` +
            `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchild)}], ` +
            `{ stdio: "ignore", windowsHide: true });\n` +
            `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, grandchild.pid]));\n` +
            `setInterval(() => {}, 1000);\n`,
        );
        const response = await terminalTool(
          { command: `"${process.execPath}" "${child}"`, timeout: 1 },
          { approvalManager: new ApprovalManager() },
        );
        expect(response).toContain("command timed out after 1s");
        expect(existsSync(pidsPath)).toBe(true);
        ownPids = JSON.parse(readFileSync(pidsPath, "utf8")) as number[];
        expect(ownPids).toHaveLength(2);
        expect(await waitUntilGone(ownPids)).toBe(true);
        expect(readdirSync(workspace).filter((name) => name.startsWith("lohra-terminal-"))).toEqual(
          [],
        );
      } finally {
        vi.unstubAllEnvs();
        for (const pid of ownPids) {
          if (isAlive(pid)) process.kill(pid);
        }
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    12_000,
  );

  it("keeps a shell failure visible and removes its capture directory", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "lohra-terminal-failure-"));
    try {
      vi.stubEnv("TEMP", workspace);
      vi.stubEnv("TMP", workspace);
      const missingShell = join(workspace, "missing-shell.exe");
      vi.stubEnv(process.platform === "win32" ? "ComSpec" : "SHELL", missingShell);
      const result = JSON.parse(
        await terminalTool(
          { command: process.platform === "win32" ? "echo OUT" : "printf OUT" },
          { approvalManager: new ApprovalManager() },
        ),
      ) as { error?: string; stderr?: string; exit_code?: number };
      if (process.platform === "win32") {
        expect(result.error).toContain("could not run command:");
        expect(result.error).toContain(missingShell);
      } else {
        expect(result.exit_code).toBe(1);
        expect(result.stderr).toContain("execvp(3) failed");
      }
      expect(readdirSync(workspace).filter((name) => name.startsWith("lohra-terminal-"))).toEqual(
        [],
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("limits large stdout and stderr by code point and removes capture files", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "lohra-terminal-output-"));
    try {
      vi.stubEnv("TEMP", workspace);
      vi.stubEnv("TMP", workspace);
      const script = join(workspace, "emit.cjs");
      writeFileSync(
        script,
        'process.stdout.write("😀".repeat(100_000)); process.stderr.write("😀".repeat(100_000));',
      );
      const result = JSON.parse(
        await terminalTool(
          { command: `node ${JSON.stringify(script)}` },
          { approvalManager: new ApprovalManager() },
        ),
      ) as { ok: boolean; stdout: string; stderr: string; exit_code: number };
      expect(result.ok).toBe(true);
      expect(result.exit_code).toBe(0);
      expect(Array.from(result.stdout)).toHaveLength(50_000);
      expect(Array.from(result.stderr)).toHaveLength(50_000);
      expect(readdirSync(workspace).filter((name) => name.startsWith("lohra-terminal-"))).toEqual(
        [],
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
