import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

describe("Windows PTY bridge", () => {
  it.skipIf(process.platform !== "win32")(
    "releases the caller's temporary cwd after a successful command",
    () => {
      const fixture = mkdtempSync(join(tmpdir(), "lohra-bridge-fixture-"));
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
});
