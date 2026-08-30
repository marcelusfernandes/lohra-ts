import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

const temporaryDirectories: string[] = [];

function environment(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "lohra-cli-test-"));
  temporaryDirectories.push(home);
  return { HOME: home, PATH: "/usr/bin:/bin", COLUMNS: "80" };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("lohra CLI bootstrap", () => {
  it("keeps version and no-command Unicode contracts distinct", async () => {
    const version: string[] = [];
    expect(
      await runCli(["--version"], {
        environment: environment(),
        stdout: (v) => version.push(v),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(version.join("")).toBe("lohra 0.0.11\n");

    const hint: string[] = [];
    expect(
      await runCli([], {
        environment: environment(),
        stdout: (v) => hint.push(v),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(hint.join("")).toBe("lohra 0.0.11 — see `lohra --help`\n");
  });

  it("emits invalid Unicode profile as ASCII JSON and raw UTF-8 stderr", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await runCli(["doctor", "--profile", "café", "--json"], {
        environment: environment(),
        stdout: (v) => stdout.push(v),
        stderr: (v) => stderr.push(v),
      }),
    ).toBe(2);
    expect(stdout.join("")).toContain("caf\\u00e9");
    expect(stdout.join("")).not.toContain("café");
    expect(stderr.join("")).toContain("café");
  });

  it("emits a sorted Python-compatible doctor payload without writing", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const env = environment();
    expect(
      await runCli(["doctor", "--json"], {
        environment: env,
        stdout: (v) => stdout.push(v),
        stderr: (v) => stderr.push(v),
        probeOllama: () => Promise.resolve(false),
      }),
    ).toBe(2);
    expect(stdout.join("")).toMatch(/^\{"checks": \[/);
    expect(stdout.join("")).toContain("\\u2014");
    expect(stdout.join("")).not.toContain("—");
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      environment: { interactive: false, stderr_tty: false, stdin_tty: false },
      exit_code: 2,
      ok: false,
    });
    expect(stderr).toEqual([]);
  });

  it("distinguishes a live Ollama with models from a live empty daemon", async () => {
    const withModels: string[] = [];
    const empty: string[] = [];
    const env = environment();
    expect(
      await runCli(["doctor", "--json"], {
        environment: env,
        stdout: (value) => withModels.push(value),
        stderr: () => undefined,
        probeOllama: () =>
          Promise.resolve({
            alive: true,
            detail: "",
            models: ["stub-coder:1b"],
            url: "http://localhost:11434/api/tags",
          }),
      }),
    ).toBe(0);
    expect(
      await runCli(["doctor", "--json"], {
        environment: env,
        stdout: (value) => empty.push(value),
        stderr: () => undefined,
        probeOllama: () =>
          Promise.resolve({
            alive: true,
            detail: "",
            models: [],
            url: "http://localhost:11434/api/tags",
          }),
      }),
    ).toBe(2);
    expect(JSON.parse(withModels.join(""))).toMatchObject({
      environment: { ollama: { alive: true, models: ["stub-coder:1b"] }, usable: true },
      exit_code: 0,
      ok: true,
    });
    expect(JSON.parse(empty.join(""))).toMatchObject({
      environment: { ollama: { alive: true, models: [] }, usable: true },
      exit_code: 2,
      ok: false,
    });
  });

  it("advertises all 13 behavioral help subcommands", async () => {
    const stdout: string[] = [];
    expect(
      await runCli(["--help"], {
        environment: environment(),
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      }),
    ).toBe(0);

    for (const command of [
      "init",
      "doctor",
      "chat",
      "dashboard",
      "serve",
      "cron",
      "workflow",
      "models",
      "tiers",
      "profile",
      "auth",
      "skill",
      "update",
    ]) {
      expect(stdout.join("")).toContain(command);
    }
  });

  it.each(["dashboard", "cron", "workflow", "update"])(
    "temporarily refuses future command %s with exit 2",
    async (command) => {
      const stderr: string[] = [];
      expect(
        await runCli([command], {
          environment: environment(),
          stdout: () => undefined,
          stderr: (value) => stderr.push(value),
        }),
      ).toBe(2);
      expect(stderr.join("")).toContain("not implemented in the TypeScript bootstrap");
    },
  );
});
