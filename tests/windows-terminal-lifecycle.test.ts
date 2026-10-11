import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

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
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    12_000,
  );
});
