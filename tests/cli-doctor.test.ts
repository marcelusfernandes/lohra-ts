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

  it("emits invalid Unicode profile as UTF-8-direct JSON and raw UTF-8 stderr (issue #71)", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await runCli(["doctor", "--profile", "café", "--json"], {
        environment: environment(),
        stdout: (v) => stdout.push(v),
        stderr: (v) => stderr.push(v),
      }),
    ).toBe(2);
    // docs/adr/0003-native-wire-format.md item 2: no more \uXXXX escaping in
    // JSON output -- stdout carries the same literal UTF-8 as stderr now.
    expect(stdout.join("")).not.toContain("caf\\u00e9");
    expect(stdout.join("")).toContain("café");
    expect(stderr.join("")).toContain("café");
  });

  it("emits a compact, UTF-8-direct doctor payload without writing (issue #71)", async () => {
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
    expect(stdout.join("")).toMatch(/^\{"checks":\[/);
    expect(stdout.join("")).not.toContain("\\u2014");
    expect(stdout.join("")).toContain("—");
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

  it("update is wired and exposes its no-side-effect help boundary", async () => {
    const stdout: string[] = [];
    expect(
      await runCli(["update", "--help"], {
        environment: environment(),
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(stdout.join("")).toContain("--check");
    expect(stdout.join("")).toContain("--reinstall");
  });

  it("requires a read-only workflow action", async () => {
    const stderr: string[] = [];
    expect(
      await runCli(["workflow"], {
        environment: environment(),
        stdout: () => undefined,
        stderr: (value) => stderr.push(value),
      }),
    ).toBe(2);
    expect(stderr.join("")).toContain("the following arguments are required: workflow_cmd");
  });

  it("dashboard is wired (T12) -- exits 2 with the same no-provider boundary as chat when unconfigured, not the stub message", async () => {
    const stderr: string[] = [];
    const code = await runCli(["dashboard"], {
      environment: environment(),
      stdout: () => undefined,
      stderr: (value) => stderr.push(value),
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("no provider configured — there are three ways in:");
    expect(stderr.join("")).not.toContain("not implemented in the TypeScript bootstrap");
  });

  it("cron now takes the real command boundary, not the stub -- documents the T18 change", async () => {
    const stderr: string[] = [];
    const code = await runCli(["cron"], {
      environment: environment(),
      stdout: () => undefined,
      stderr: (value) => stderr.push(value),
    });
    expect(code).toBe(2);
    expect(stderr.join("")).not.toContain("not implemented in the TypeScript bootstrap");
    // `cron` with no action at all is argparse's "required argument missing" class
    // (byte-exact: "the following arguments are required: action"), a DIFFERENT
    // error class from "invalid choice" -- an explicitly-provided-but-wrong value
    // (e.g. `cron frobnicate`) is what produces "invalid choice", exercised
    // separately in tests/commands-cron.test.ts and the T18 cli-bilateral harness.
    expect(stderr.join("")).toContain("the following arguments are required: action");
  });
});
