import net from "node:net";

import { describe, expect, it } from "vitest";

import { runServe } from "../src/commands/serve.js";

function collector(): { readonly text: () => string; readonly write: (value: string) => void } {
  let buffer = "";
  return { text: () => buffer, write: (value) => { buffer += value; } };
}

function baseEnvironment(): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "dummy-not-real",
    LOHRA_HOME: "/tmp/t11-serve-test-home",
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => { resolve(port); });
    });
  });
}

describe("runServe", () => {
  it("refuses when no provider can be resolved from the environment", async () => {
    const stderr = collector();
    const code = await runServe({
      configuration: { host: "127.0.0.1", port: 8000, insecure: false, tools: "" },
      environment: { PATH: "/usr/bin" },
      stdout: () => {},
      stderr: stderr.write,
    });
    expect(code).toBe(2);
    expect(stderr.text()).toContain("no provider configured");
  });

  it("starts, prints the banner and API key (no --insecure), then SIGINT stops it cleanly and frees the port", async () => {
    const port = await freePort();
    const stderr = collector();
    const runPromise = runServe({
      configuration: { host: "127.0.0.1", port, insecure: false, tools: "" },
      environment: baseEnvironment(),
      stdout: () => {},
      stderr: stderr.write,
    });

    await waitFor(() => stderr.text().includes("Lohra OpenAI server:"));
    expect(stderr.text()).toContain(`http://127.0.0.1:${String(port)}/v1`);
    expect(stderr.text()).toContain("API key:");

    process.emit("SIGINT", "SIGINT");
    const code = await runPromise;
    expect(code).toBe(0);

    // The port must be free immediately for another bind (assertion 66).
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => { resolve(); }));
    });
  });

  it("--insecure starts without printing an API key line", async () => {
    const port = await freePort();
    const stderr = collector();
    const runPromise = runServe({
      configuration: { host: "127.0.0.1", port, insecure: true, tools: "" },
      environment: baseEnvironment(),
      stdout: () => {},
      stderr: stderr.write,
    });
    await waitFor(() => stderr.text().includes("Lohra OpenAI server:"));
    expect(stderr.text()).not.toContain("API key:");
    process.emit("SIGINT", "SIGINT");
    await runPromise;
  });

  it("agentic mode (--tools) prints the enabled-tools warning, including '(none matched)' when nothing resolves", async () => {
    const port = await freePort();
    const stderr = collector();
    const runPromise = runServe({
      configuration: { host: "127.0.0.1", port, insecure: false, tools: "nosuchtool" },
      environment: baseEnvironment(),
      stdout: () => {},
      stderr: stderr.write,
    });
    await waitFor(() => stderr.text().includes("Lohra OpenAI server:"));
    expect(stderr.text()).toContain("agentic mode");
    expect(stderr.text()).toContain("(none matched)");
    process.emit("SIGINT", "SIGINT");
    await runPromise;
  });

  it("refuses to bind an occupied port without touching the occupying listener", async () => {
    const port = await freePort();
    const occupying = net.createServer();
    await new Promise<void>((resolve) => occupying.listen(port, "127.0.0.1", resolve));

    const stderr = collector();
    const code = await runServe({
      configuration: { host: "127.0.0.1", port, insecure: false, tools: "" },
      environment: baseEnvironment(),
      stdout: () => {},
      stderr: stderr.write,
    });
    expect(code).toBe(2);
    expect(stderr.text()).toContain("already in use");

    // The occupying listener must still be alive and unaffected.
    await new Promise<void>((resolve, reject) => {
      const client = net.connect(port, "127.0.0.1", () => {
        client.end();
        resolve();
      });
      client.once("error", reject);
    });
    occupying.close();
  });
});
