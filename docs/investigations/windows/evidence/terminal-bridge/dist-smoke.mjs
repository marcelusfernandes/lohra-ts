import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.argv[2];
if (!checkout) throw new Error("usage: node dist-smoke.mjs <checkout>");

const root = mkdtempSync(join(tmpdir(), "lohra-bridge-dist-"));
const before = process.cwd();
const entry = pathToFileURL(join(checkout, "dist/tools/terminal-windows.js"));
const { runWindowsTerminalBridge } = await import(entry.href);
let raw;
try {
  process.chdir(root);
  raw = await runWindowsTerminalBridge({ command: "echo DIST_BRIDGE_OK" });
} finally {
  process.chdir(before);
}
let removed = false;
let cleanupError = null;
try {
  rmSync(root, { recursive: true, force: true });
  removed = true;
} catch (error) {
  cleanupError = error instanceof Error ? error.message : String(error);
}
const result = JSON.parse(raw);
console.log(
  JSON.stringify({
    node: process.version,
    ok: result.ok === true,
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exit_code,
    removed,
    cleanupError,
  }),
);
