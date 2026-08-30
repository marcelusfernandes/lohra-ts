import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeConfig, writeTokens } from "../src/auth/store.js";
import { runCli, type CliIo } from "../src/cli.js";

const roots: string[] = [];
const fixture = (): { home: string; codexHome: string; environment: Record<string, string> } => {
  const root = mkdtempSync(join(tmpdir(), "lohra-auth-cli-"));
  roots.push(root);
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  return {
    home: join(home, ".lohra"),
    codexHome,
    environment: {
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TZ: "UTC",
    },
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function invoke(argv: readonly string[], environment: Record<string, string>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    environment,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    probeOllama: () => Promise.resolve(false),
  };
  const code = await runCli(argv, io);
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("public auth surfaces", () => {
  it("renders insertion-order auth status and enables only with explicit acknowledgement", async () => {
    const value = fixture();
    const off = await invoke(["auth", "status", "--no-input"], value.environment);
    expect(off).toEqual({
      code: 0,
      stderr: "",
      stdout:
        '{\n  "mode": "api_key",\n  "active": false,\n  "preference": "auto",\n  "acknowledged_tos_risk": false,\n  "own_login": false,\n  "own_login_expired": null,\n  "codex_login_found": false,\n  "codex_token_expired": null,\n  "account_id": null\n}\n',
    });
    const refused = await invoke(["auth", "enable", "--no-input"], value.environment);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("requires `lohra auth enable --yes`");
    const enabled = await invoke(["auth", "enable", "--yes"], value.environment);
    expect(enabled.code).toBe(0);
    expect(enabled.stdout).toContain("subscription mode enabled (OpenAI/Codex)");
  });

  it("matches the two subscription chat failures before transport", async () => {
    const value = fixture();
    writeConfig(value.home, {
      authMode: "subscription",
      acknowledgedTosRisk: true,
      preference: "auto",
    });
    const noLogin = await invoke(["chat", "fixture", "--json", "--no-input"], value.environment);
    expect(noLogin.code).toBe(2);
    expect(JSON.parse(noLogin.stdout)).toMatchObject({
      model: "gpt-5.5",
      completed: false,
      api_calls: 0,
    });
    expect(noLogin.stderr).toContain("subscription mode: not logged in");

    writeConfig(value.home, {
      authMode: "api_key",
      acknowledgedTosRisk: false,
      preference: "subscription",
    });
    const inactive = await invoke(["chat", "fixture", "--json", "--no-input"], value.environment);
    expect(inactive.code).toBe(2);
    expect(inactive.stderr).toContain("preference=subscription");
    expect(JSON.parse(inactive.stdout)).toMatchObject({ model: null, api_calls: 0 });
  });

  it("keeps the serve gate unconditional and exposes the configured Codex model offline", async () => {
    const value = fixture();
    writeConfig(value.home, {
      authMode: "subscription",
      acknowledgedTosRisk: true,
      preference: "api_key",
    });
    const served = await invoke(["serve"], value.environment);
    expect(served.code).toBe(2);
    expect(served.stderr).toContain("gate is unconditional");

    writeFileSync(join(value.codexHome, "config.toml"), 'model = "gpt-eval-t05"\n');
    const models = await invoke(
      ["models", "--provider", "openai-codex", "--json"],
      value.environment,
    );
    expect(models.code).toBe(0);
    const modelsPayload = JSON.parse(models.stdout) as {
      readonly providers: readonly unknown[];
    };
    expect(modelsPayload.providers[0]).toEqual({
      provider: "openai-codex",
      source: "config",
      total: 1,
      models: ["gpt-eval-t05"],
      detail: "subscription; no live listing — model from the Codex config",
    });
  });

  it("doctor reports a fixed future own login without writing", async () => {
    const value = fixture();
    writeConfig(value.home, {
      authMode: "subscription",
      acknowledgedTosRisk: true,
      preference: "auto",
    });
    writeTokens(value.home, {
      accessToken: "DUMMY-T05-ACCESS",
      refreshToken: "DUMMY-T05-REFRESH",
      accountId: "ACCT-T05-DUMMY",
      expiresAt: 2_000_000_000,
    });
    const doctor = await invoke(["doctor", "--json"], value.environment);
    const payload = JSON.parse(doctor.stdout) as {
      readonly environment: Record<string, unknown>;
      readonly checks: readonly { readonly detail: string }[];
    };
    expect(doctor.code).toBe(0);
    expect(payload.environment).toMatchObject({
      subscription_active: true,
      auth_route: "subscription",
      usable: true,
    });
    expect(payload.checks.slice(1, 4).map((check) => check.detail)).toEqual([
      "OpenAI/Codex subscription (opt-in, ToS-gray)",
      `active (OpenAI/Codex) — ${value.home}/auth.json`,
      "own OAuth token valid until 2033-05-18 03:33",
    ]);
  });
});
