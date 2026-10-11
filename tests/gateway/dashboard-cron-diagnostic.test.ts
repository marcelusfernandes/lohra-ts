import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { runDashboard, type DashboardCommandOptions } from "../../src/commands/dashboard.js";
import { CronStore } from "../../src/cron/store.js";
import { registerProvider } from "../../src/providers/registry.js";

it("sends a scheduled callback failure to dashboard stderr without exposing input or credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "lohra-cron-dashboard-"));
  const home = join(root, "home");
  const prompt = "PROMPT_SECRET_762";
  const credential = "CREDENTIAL_SECRET_762";
  const providerDetail = "PROVIDER_SECRET_762";
  const stderrLines: string[] = [];
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: providerDetail } }));
  });
  const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const stdout = vi.spyOn(process.stdout, "write");
  let shutdown: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing stub port");
    const provider = "t762-cron-dashboard-probe";
    registerProvider({
      name: provider,
      apiMode: "anthropic_messages",
      aliases: [],
      displayName: "T762 cron dashboard probe",
      description: "Local failure stub for the scheduled dashboard callback.",
      signupUrl: "",
      envVars: ["T762_DASH_KEY"],
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      modelsUrl: "",
      requiresApiKey: true,
      supportsVision: false,
      fallbackModels: ["t762-model"],
      defaultMaxTokens: 256,
      defaultAuxModel: "",
    });
    const job = new CronStore(home).add({
      name: "failed",
      prompt,
      type: "once",
      value: Date.now() / 1000 - 10,
    });
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const options: DashboardCommandOptions = {
      flags: new Map([
        ["--provider", provider],
        ["--model", "t762-model"],
      ]),
      environment: { HOME: root, PATH: process.env.PATH ?? "", T762_DASH_KEY: credential },
      home,
      codexHome: join(root, "codex"),
      cwd: root,
      stderr: (line) => stderrLines.push(line),
      port: 0,
      registerShutdownTrigger: (trigger) => {
        shutdown = trigger;
        resolveReady?.();
      },
    };
    const done = runDashboard(options);
    await Promise.race([ready, done]);
    for (
      let attempt = 0;
      attempt < 200 && !stderrLines.some((line) => line.includes("phase=callback"));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    shutdown?.();
    expect(await done).toBe(0);
    expect(requests).toBeGreaterThan(0);
    expect(new CronStore(home).get(job.id)?.last_run_at).not.toBeNull();
    expect(stderrLines).toContain(`cron job ${job.id} phase=callback cause=Error\n`);
    const diagnostic = stderrLines.join("");
    expect(diagnostic).not.toContain(prompt);
    expect(diagnostic).not.toContain(credential);
    expect(diagnostic).not.toContain(providerDetail);
    expect(stdout.mock.calls.flat().join("")).not.toContain("phase=callback");
    expect(consoleWarning.mock.calls.flat().join("")).not.toContain("phase=callback");
  } finally {
    shutdown?.();
    stdout.mockRestore();
    consoleWarning.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }),
    );
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
