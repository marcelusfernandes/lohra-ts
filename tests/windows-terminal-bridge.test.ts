import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalManager } from "../src/tools/approval.js";
import { terminalTool } from "../src/tools/terminal.js";
import { runWindowsTerminalBridge } from "../src/tools/terminal-windows.js";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function worker(body: string): URL {
  const fixture = mkdtempSync(join(tmpdir(), "lohra-bridge-protocol-"));
  fixtures.push(fixture);
  const script = join(fixture, "worker.mjs");
  writeFileSync(script, body);
  return pathToFileURL(script);
}

describe("Windows PTY bridge", () => {
  it.skipIf(process.platform !== "win32")(
    "releases the caller's temporary cwd after a successful command",
    () => {
      const fixture = mkdtempSync(join(tmpdir(), "lohra-bridge-fixture-"));
      fixtures.push(fixture);
      const script = join(fixture, "run.mjs");
      const bridge = pathToFileURL(join(process.cwd(), "src/tools/terminal-windows.ts")).href;
      writeFileSync(
        script,
        `import { mkdtempSync, rmSync } from "node:fs";\n` +
          `import { tmpdir } from "node:os";\n` +
          `import { join } from "node:path";\n` +
          `import { runWindowsTerminalBridge } from ${JSON.stringify(bridge)};\n` +
          `const before = process.cwd();\n` +
          `const root = mkdtempSync(join(tmpdir(), "lohra-bridge-cwd-"));\n` +
          `process.chdir(root);\n` +
          `const result = JSON.parse(await runWindowsTerminalBridge({ command: "echo LOHRA_BRIDGE_OK" }));\n` +
          `process.chdir(before);\n` +
          `let removed = false; let cleanupError = null;\n` +
          `try { rmSync(root, { recursive: true, force: true }); removed = true; }\n` +
          `catch (error) { cleanupError = error.code; }\n` +
          `console.log(JSON.stringify({ result, removed, cleanupError }));\n`,
      );
      const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script], {
        cwd: process.cwd(),
        env: { ...process.env, TEMP: fixture, TMP: fixture },
        encoding: "utf8",
        timeout: 12_000,
        maxBuffer: 256_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const observed = JSON.parse(child.stdout) as {
        result: { ok: boolean; stdout: string; stderr: string; exit_code: number };
        removed: boolean;
        cleanupError: string | null;
      };
      expect(observed.result).toEqual({
        ok: true,
        stdout: "LOHRA_BRIDGE_OK\r\n",
        stderr: "",
        exit_code: 0,
      });
      expect(observed.removed, observed.cleanupError ?? "").toBe(true);
    },
    15_000,
  );

  it("fails closed on premature EOF and malformed protocol frames", async () => {
    const eof = JSON.parse(
      await runWindowsTerminalBridge({ command: "echo OUT" }, { workerUrl: worker("") }),
    ) as { error: string };
    expect(eof.error).toContain("closed before complete protocol response");

    const malformed = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo OUT" },
        { workerUrl: worker('process.stdout.write("not-json\\n");') },
      ),
    ) as { error: string };
    expect(malformed.error).toContain("malformed ready frame");
  });

  it("preserves spawn and worker setup errors as faults", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "lohra-bridge-spawn-"));
    fixtures.push(fixture);
    const missingNode = join(fixture, "missing-node.exe");
    const spawnFailure = JSON.parse(
      await runWindowsTerminalBridge({ command: "echo OUT" }, { nodeExecutable: missingNode }),
    ) as { error: string };
    expect(spawnFailure.error).toContain("worker spawn failed:");
    expect(spawnFailure.error).toContain("ENOENT");

    const setupFailure = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo OUT" },
        {
          workerUrl: worker(
            'console.log(\'{"type":"fault","message":"setup failed"}\'); process.exitCode = 1;',
          ),
        },
      ),
    ) as { error: string };
    expect(setupFailure.error).toContain("worker failed: setup failed");
  });

  it("does not accept a result from a crashed worker or an invalid envelope", async () => {
    const valid = JSON.stringify({ type: "result", value: JSON.stringify({ ok: true }) });
    const crashed = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo OUT" },
        {
          workerUrl: worker(
            `console.log('{"type":"ready"}'); console.log(${JSON.stringify(valid)}); process.exitCode = 7;`,
          ),
        },
      ),
    ) as { error: string };
    expect(crashed.error).toContain("worker exited 7");

    const invalid = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo OUT" },
        {
          workerUrl: worker(
            'console.log(\'{"type":"ready"}\'); console.log(\'{"type":"result","value":"{}"}\');',
          ),
        },
      ),
    ) as { error: string };
    expect(invalid.error).toContain("invalid tool envelope");

    const wrongType = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo OUT" },
        {
          workerUrl: worker(
            `console.log('{"type":"ready"}'); console.log(${JSON.stringify(
              JSON.stringify({ type: "result", value: JSON.stringify({ ok: "yes" }) }),
            )});`,
          ),
        },
      ),
    ) as { error: string };
    expect(wrongType.error).toContain("invalid tool envelope");

    const crashBeforeReady = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo OUT" },
        { workerUrl: worker('console.error("CRASH_CAUSE"); process.exitCode = 9;') },
      ),
    ) as { error: string };
    expect(crashBeforeReady.error).toContain("exit 9");
    expect(crashBeforeReady.error).toContain("CRASH_CAUSE");
  });

  it("bounds requests and responses before accepting a result", async () => {
    const oversizedRequest = JSON.parse(
      await runWindowsTerminalBridge({ command: "x".repeat(70_000) }),
    ) as { error: string };
    expect(oversizedRequest.error).toContain("request exceeds 65536 bytes");

    const oversizedResponse = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo OUT" },
        {
          workerUrl: worker(
            'process.stdout.write("x".repeat(1100000)); setInterval(() => {}, 1000);',
          ),
        },
      ),
    ) as { error: string };
    expect(oversizedResponse.error).toContain("response exceeds 1048576 bytes");
  }, 12_000);

  it("terminates only its own worker tree after a bounded execution deadline", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "lohra-bridge-timeout-"));
    fixtures.push(fixture);
    const pidPath = join(fixture, "pid.txt");
    const script = join(fixture, "worker.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\n` +
        `console.log('{"type":"ready"}'); setInterval(() => {}, 1000);\n`,
    );
    const response = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo OUT", timeout: 0 },
        { workerUrl: pathToFileURL(script) },
      ),
    ) as { error: string };
    expect(response.error).toContain("execution deadline");
    expect(existsSync(pidPath)).toBe(true);
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("bounds cleanup after a final frame even when execution timeout is null", async () => {
    const result = JSON.stringify({
      type: "result",
      value: JSON.stringify({ ok: true, stdout: "OUT", stderr: "", exit_code: 0 }),
    });
    const response = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo OUT", timeout: null },
        {
          workerUrl: worker(
            `console.log('{"type":"ready"}'); console.log(${JSON.stringify(result)}); setInterval(() => {}, 1000);`,
          ),
        },
      ),
    ) as { error: string };
    expect(response.error).toContain("returned a result but did not exit within 5000ms");
  }, 12_000);

  it("rejects malformed request JSON in the real worker", () => {
    const workerPath = join(process.cwd(), "src/tools/terminal-windows-worker.ts");
    for (const input of [
      "not-json\n",
      '{"version":1,"args":{"command":"echo OUT","cwd":{}},"timeoutKind":null}\n',
    ]) {
      const child = spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), workerPath],
        {
          cwd: dirname(process.execPath),
          input,
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 8_192,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      const frame = JSON.parse(child.stdout.trim()) as { type: string; message: string };
      expect(frame.type).toBe("fault");
      expect(frame.message).toMatch(/JSON|schema/);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "terminates a grandchild owned by a timed-out worker without scanning unrelated PIDs",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "lohra-bridge-tree-"));
      fixtures.push(fixture);
      const pidPath = join(fixture, "pids.json");
      const grandchild = join(fixture, "grandchild.cjs");
      const workerPath = join(fixture, "worker.mjs");
      writeFileSync(grandchild, "setInterval(() => {}, 1000);\n");
      writeFileSync(
        workerPath,
        `import { spawn } from "node:child_process";\n` +
          `import { writeFileSync } from "node:fs";\n` +
          `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore", windowsHide: true });\n` +
          `writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify([process.pid, child.pid]));\n` +
          `console.log('{"type":"ready"}'); setInterval(() => {}, 1000);\n`,
      );
      const response = JSON.parse(
        await runWindowsTerminalBridge(
          { command: "echo OUT", timeout: 0 },
          { workerUrl: pathToFileURL(workerPath) },
        ),
      ) as { error: string };
      expect(response.error).toContain("execution deadline");
      const pids = JSON.parse(readFileSync(pidPath, "utf8")) as number[];
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "preserves stdout, stderr and exit 7 in a Unicode cwd",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "lohra bridge espaço ü "));
      fixtures.push(fixture);
      writeFileSync(join(fixture, "marker.txt"), "OUT");
      const args = { command: "type marker.txt & echo ERR 1>&2 & exit /b 7", cwd: fixture };
      const result = JSON.parse(await runWindowsTerminalBridge(args)) as {
        ok: boolean;
        stdout: string;
        stderr: string;
        exit_code: number;
      };
      const direct = JSON.parse(
        await terminalTool(args, { approvalManager: new ApprovalManager() }),
      ) as typeof result;
      expect(result).toEqual(direct);
      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("OUT");
      expect(result.stderr.trim()).toBe("ERR");
      expect(result.exit_code).toBe(7);
    },
    12_000,
  );

  it.skipIf(process.platform !== "win32")(
    "retains the 50000-code-point limit independently for both streams",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "lohra-bridge-unicode-"));
      fixtures.push(fixture);
      const emitter = join(fixture, "emit.cjs");
      writeFileSync(
        emitter,
        'process.stdout.write("😀".repeat(60000)); process.stderr.write("😀".repeat(60000));',
      );
      const result = JSON.parse(
        await runWindowsTerminalBridge({
          command: `"${process.execPath}" "${emitter}"`,
          cwd: fixture,
        }),
      ) as { ok: boolean; stdout: string; stderr: string; exit_code: number };
      expect(result.ok).toBe(true);
      expect(result.exit_code).toBe(0);
      expect(Array.from(result.stdout)).toHaveLength(50_000);
      expect(Array.from(result.stderr)).toHaveLength(50_000);
    },
    15_000,
  );
});
