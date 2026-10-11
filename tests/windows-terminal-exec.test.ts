import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalManager } from "../src/tools/approval.js";
import { terminalShellInvocation, terminalTool } from "../src/tools/terminal.js";

let workspace: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe("Windows terminal execution", () => {
  it("passes a raw cmd command line to node-pty without escaping redirection quotes", () => {
    const stdout = String.raw`C:\capture space ü\stdout`;
    const stderr = String.raw`C:\capture space ü\stderr`;
    expect(terminalShellInvocation("echo OUT", stdout, stderr, "win32")).toEqual({
      executable: process.env.ComSpec ?? "cmd.exe",
      args: `/d /s /c (echo OUT) 1>"${stdout}" 2>"${stderr}"`,
    });
  });

  it.skipIf(process.platform !== "win32")(
    "captures stdout, stderr and exit 7 in a Unicode cwd with spaces",
    async () => {
      workspace = mkdtempSync(join(tmpdir(), "lohra terminal espaço ü "));
      writeFileSync(join(workspace, "marker.txt"), "OUT");
      const response = await terminalTool(
        {
          command: "type marker.txt & echo ERR 1>&2 & exit /b 7",
          cwd: workspace,
        },
        { approvalManager: new ApprovalManager() },
      );
      const result = JSON.parse(response) as {
        ok: boolean;
        stdout: string;
        stderr: string;
        exit_code: number;
      };
      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("OUT");
      expect(result.stderr.trim()).toBe("ERR");
      expect(result.exit_code).toBe(7);
      expect(readFileSync(join(workspace, "marker.txt"), "utf8")).toBe("OUT");
    },
  );

  it("reports a spawn failure with the missing shell as a cause", async () => {
    workspace = mkdtempSync(join(tmpdir(), "lohra terminal spawn ü "));
    const missing = join(workspace, "missing-shell.exe");
    vi.stubEnv(process.platform === "win32" ? "ComSpec" : "SHELL", missing);
    const response = await terminalTool(
      { command: process.platform === "win32" ? "echo OUT" : "printf OUT", cwd: workspace },
      { approvalManager: new ApprovalManager() },
    );
    const result = JSON.parse(response) as { error: string; command: string };
    expect(result.error).toContain("could not run command:");
    expect(result.error).toContain(missing);
  });

  it("reports a shell syntax/command failure instead of an empty success", async () => {
    const command = "lohra_missing_command_743";
    const response = await terminalTool({ command }, { approvalManager: new ApprovalManager() });
    const result = JSON.parse(response) as { ok: boolean; stderr: string; exit_code: number };
    expect(result.ok).toBe(true);
    expect(result.exit_code).not.toBe(0);
    expect(result.stderr).toContain(command);
  });

  it("keeps the dangerous-command refusal before spawning a shell", async () => {
    const response = await terminalTool(
      { command: "sudo echo OUT" },
      { approvalManager: new ApprovalManager() },
    );
    const result = JSON.parse(response) as { error: string; refusal: string };
    expect(result.error).toContain("dangerous-command policy");
    expect(result.refusal).toBe("final");
  });
});
