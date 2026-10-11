import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runWindowsTerminalBridge } from "../src/tools/terminal-windows.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function worker(source: string | ((root: string) => string)): { url: URL; root: string } {
  const root = mkdtempSync(join(tmpdir(), "lohra-terminal-signal-"));
  roots.push(root);
  const path = join(root, "worker.mjs");
  writeFileSync(path, typeof source === "string" ? source : source(root));
  return { url: pathToFileURL(path), root };
}

async function waitFor(path: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("worker did not start");
}

describe("terminal bridge signal cancellation (#920)", () => {
  it("does not spawn when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo should-not-run" },
        { signal: controller.signal, nodeExecutable: "missing-node-executable" },
      ),
    ) as { error: string };
    expect(result.error).toMatch(/cancel/i);
  });

  it("stops its own in-flight worker promptly and removes the abort listener", async () => {
    const { url, root } = worker(
      (root) =>
        `import { writeFileSync } from "node:fs";\n` +
        `process.stdout.write(JSON.stringify({type:"ready"})+"\\n");\n` +
        `writeFileSync(${JSON.stringify(join(root, "ready"))}, "ready");\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    const controller = new AbortController();
    const started = performance.now();
    const running = runWindowsTerminalBridge(
      { command: "echo held" },
      { signal: controller.signal, workerUrl: url },
    );
    await waitFor(join(root, "ready"));
    controller.abort();
    const result = JSON.parse(await running) as { error: string };
    expect(result.error).toMatch(/cancel/i);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }, 12_000);

  it("keeps normal result and removes the abort listener without a signal", async () => {
    const value = JSON.stringify({ ok: true, stdout: "ok", stderr: "", exit_code: 0 });
    const { url } = worker(
      `process.stdout.write(JSON.stringify({type:"ready"})+"\\n");\n` +
        `process.stdin.resume();\n` +
        `process.stdin.on("end", () => { process.stdout.write(JSON.stringify({type:"result",value:${JSON.stringify(value)}})+"\\n"); });\n`,
    );
    const controller = new AbortController();
    const result = JSON.parse(
      await runWindowsTerminalBridge(
        { command: "echo ok" },
        { signal: controller.signal, workerUrl: url },
      ),
    ) as { ok: boolean; stdout: string };
    expect(result).toMatchObject({ ok: true, stdout: "ok" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
