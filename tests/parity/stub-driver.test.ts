import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { completion } from "../../scripts/parity/stub/server.js";

const driver = new URL("../../scripts/parity/stub/driver.ts", import.meta.url);
const tsxLoader = import.meta.resolve("tsx");

it("keeps usage in default completions and omits it only when requested", () => {
  const message = { role: "assistant", content: "ok" };
  expect(completion(message, "stop")).toMatchObject({
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
  expect(completion(message, "stop", false)).not.toHaveProperty("usage");
});

async function bindPort(): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(11_434, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

it("kills a timed-out target tree and releases the stub port before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "lohra-stub-driver-test-"));
  try {
    const config = join(root, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        scenario: "timeout-lifecycle",
        side: "oracle",
        stub: {
          state: "up-with-models",
          fixture: "doctor",
          requestLog: { comparedHeaders: [], excludedHeaders: [] },
        },
        limits: { timeoutMs: 100, maxOutputBytes: 16_384 },
        target: {
          executable: process.execPath,
          argv: ["--input-type=module", "-e", "setTimeout(() => {}, 5000)"],
          cwd: root,
          environment: { PATH: "/usr/bin:/bin" },
        },
        logs: {
          projected: join(root, "projected.jsonl"),
          raw: join(root, "raw.jsonl"),
          summary: join(root, "summary.json"),
          assertions: join(root, "assertions.json"),
        },
      }),
    );

    const result = spawnSync(process.execPath, ["--import", tsxLoader, driver.pathname, config], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(88);
    await bindPort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("installs the dynamic-port redirect for candidate targets too", () => {
  const root = mkdtempSync(join(tmpdir(), "lohra-stub-driver-candidate-"));
  try {
    const config = join(root, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        scenario: "candidate-dynamic-port",
        side: "candidate",
        port: 0,
        stub: {
          state: "up-with-models",
          fixture: "doctor",
          requestLog: { comparedHeaders: [], excludedHeaders: [] },
        },
        limits: { timeoutMs: 5_000, maxOutputBytes: 16_384 },
        target: {
          executable: process.execPath,
          argv: [
            "--input-type=module",
            "-e",
            "process.stdout.write(JSON.stringify({ pythonPath: process.env.PYTHONPATH, original: process.env.LOHRA_PARITY_ORIGINAL_PYTHONPATH }))",
          ],
          cwd: root,
          environment: { PATH: "/usr/bin:/bin", PYTHONPATH: "/original" },
        },
        logs: {
          projected: join(root, "projected.jsonl"),
          raw: join(root, "raw.jsonl"),
          summary: join(root, "summary.json"),
          assertions: join(root, "assertions.json"),
        },
      }),
    );

    const result = spawnSync(process.execPath, ["--import", tsxLoader, driver.pathname, config], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const environment = JSON.parse(result.stdout) as {
      readonly pythonPath?: string;
      readonly original?: string;
    };
    expect(environment.original, "MUTATION_CAUSE:T22-candidate-dynamic-stub-redirect").toBe(
      "/original",
    );
    expect(environment.pythonPath, "MUTATION_CAUSE:T22-candidate-dynamic-stub-redirect").toContain(
      "python-sitecustomize",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
