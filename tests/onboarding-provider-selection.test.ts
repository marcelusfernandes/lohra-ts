import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const envWrites = vi.hoisted(() => [] as Record<string, string>[]);

vi.mock("../src/onboarding/env-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/onboarding/env-write.js")>();
  const { atomicWrite0600 } = await import("../src/auth/json-file.js");
  return {
    ...actual,
    upsertEnvFile: (
      path: string,
      updates: Readonly<Record<string, string>>,
      ops?: Parameters<typeof actual.upsertEnvFile>[2],
    ) => {
      envWrites.push({ ...updates });
      if (process.platform !== "win32" || ops !== undefined)
        return actual.upsertEnvFile(path, updates, ops);
      const forbidden = () => {
        throw new Error("legacy .env writer used by Windows fixture");
      };
      return actual.upsertEnvFile(path, updates, {
        platform: "win32",
        privateWrite: (target, body) => {
          atomicWrite0600(target, body);
        },
        writeText: forbidden,
        chmod600: forbidden,
        replace: forbidden,
      });
    },
  };
});

import { readConfig } from "../src/auth/store.js";
import { TerminalInputError } from "../src/cli/terminal-io.js";
import {
  defaultFromLine,
  keysToAsk,
  persistProviderPlan,
  providersFromLine,
  type InitProviderId,
} from "../src/onboarding/provider-selection.js";
import {
  Prompter,
  markerPresent,
  runInit,
  type OnboardingSnapshot,
} from "../src/onboarding/wizard.js";
import { listSkillClients, type SkillClient } from "../src/skills/clients.js";

const OPENROUTER_KEY = "openrouter-fixture-key-939";
const ANTHROPIC_KEY = "anthropic-fixture-key-939";
const ACCOUNT = "acct-fixture-939";
const REFRESH = "refresh-fixture-939";

const root = (): string => mkdtempSync(join(tmpdir(), "lohra-provider-init-"));

function snapshot(base: string): OnboardingSnapshot {
  return {
    activeProfile: null,
    authPreference: "auto",
    authRoute: "api_key",
    detectedProvider: null,
    envFile: join(base, ".env"),
    envFilePresent: false,
    harnesses: [],
    home: base,
    interactive: true,
    ollama: { alive: false, models: [], url: "http://localhost:11434/api/tags" },
    providerError: null,
    providerOrigin: "none",
    providerNames: ["anthropic", "openai", "openrouter"],
    presentProviderVars: [],
    subscriptionActive: false,
  };
}

function jwt(exp: number): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ exp, chatgpt_account_id: ACCOUNT })}.sig`;
}

function writeCodexLogin(codexHome: string, exp = 4_000_000_000): string {
  mkdirSync(codexHome, { recursive: true });
  const token = jwt(exp);
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({
      tokens: { access_token: token, refresh_token: REFRESH, account_id: ACCOUNT },
    }),
  );
  return token;
}

function assertHidden(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(8);
    expect(text).not.toContain(secret);
  }
  expect(text).not.toContain("account_id");
  expect(text).not.toContain("access_token");
}

async function init(options: {
  readonly base?: string;
  readonly providers: readonly InitProviderId[];
  readonly answers?: readonly string[];
  readonly defaultProvider?: InitProviderId;
  readonly environment?: Record<string, string>;
  readonly chooseClients?: () => Promise<readonly SkillClient[]>;
}): Promise<{
  readonly result: number;
  readonly prompts: string;
  readonly out: string;
  readonly base: string;
  readonly home: string;
  readonly usable: string;
}> {
  const base = options.base ?? root();
  const home = join(base, "profile");
  const answers = [...(options.answers ?? [])];
  const prompts: string[] = [];
  let out = "";
  let usable = "";
  const result = await runInit({
    snapshot: snapshot(home),
    base,
    home,
    codexHome: join(base, "codex"),
    environment: { HOME: base, ...(options.environment ?? {}) },
    noInput: false,
    isTty: true,
    prompter: new Prompter(
      () => answers.shift() ?? "",
      (text) => {
        prompts.push(text);
      },
    ),
    writeOut: (text) => {
      out += text;
    },
    chooseProviders: () => Promise.resolve(options.providers),
    chooseDefault: (choices) => {
      usable = choices.join(",");
      if (options.defaultProvider === undefined) {
        throw new Error(`unexpected default prompt: ${usable}`);
      }
      return Promise.resolve(options.defaultProvider);
    },
    chooseClients: options.chooseClients ?? (() => Promise.resolve([])),
  });
  return { result, prompts: prompts.join("\n"), out, base, home, usable };
}

describe("provider selection", () => {
  it("parses the three providers and asks OpenRouter for a key before Anthropic", () => {
    expect([...providersFromLine(" Claude (Anthropic API), Codex , or ")].sort()).toEqual([
      "anthropic",
      "codex",
      "openrouter",
    ]);
    expect(() => providersFromLine("openai")).toThrow("unknown provider");
    expect(defaultFromLine("claude", ["anthropic"])).toBe("anthropic");
    expect(() => defaultFromLine("codex", ["anthropic"])).toThrow("usable default");
    expect(keysToAsk(["anthropic", "openrouter", "codex"], {})).toEqual([
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
    ]);
    expect(keysToAsk(["anthropic", "openrouter"], { OPENROUTER_API_KEY: "already" })).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
  });

  it("saves both keys in one update and keeps an API default on prefer api_key", async () => {
    envWrites.length = 0;
    const token = writeCodexLogin(join(root(), "unused"));
    const run = await init({
      providers: ["anthropic", "codex", "openrouter"],
      answers: [OPENROUTER_KEY, ANTHROPIC_KEY, "y"],
      defaultProvider: "anthropic",
    });
    expect(run.usable).toBe("anthropic,openrouter");
    expect(run.prompts.indexOf("OPENROUTER_API_KEY")).toBeLessThan(
      run.prompts.indexOf("ANTHROPIC_API_KEY"),
    );
    expect(run.prompts.indexOf("ANTHROPIC_API_KEY")).toBeLessThan(
      run.prompts.indexOf("Enable Codex subscription mode anyway?"),
    );
    expect(envWrites).toEqual([
      {
        OPENROUTER_API_KEY: OPENROUTER_KEY,
        ANTHROPIC_API_KEY: ANTHROPIC_KEY,
        LOHRA_PROVIDER: "anthropic",
      },
    ]);
    expect(readConfig(run.home)).toEqual({
      authMode: "subscription",
      acknowledgedTosRisk: true,
      preference: "api_key",
    });
    expect(run.out).toContain("preference api_key (Codex subscription stays opted in)");
    expect(run.out).toContain("is pending: no valid local login");
    expect(run.out).toContain("lohra auth login");
    expect(run.out).toContain("codex login");
    expect(run.out).toContain("Remote authentication was not checked.");
    expect(run.out).not.toContain("ready — OpenAI/Codex");
    expect(run.out).not.toContain("Waiting for authorization");
    expect(existsSync(join(run.home, "oauth.json"))).toBe(false);
    expect(run.result).toBe(0);
    expect(markerPresent(run.home)).toBe(true);
    assertHidden(`${run.prompts}\n${run.out}`, [
      OPENROUTER_KEY,
      ANTHROPIC_KEY,
      ACCOUNT,
      REFRESH,
      token,
    ]);
  });

  it("requires subscription consent before a Codex default and does not start login", async () => {
    const declined = await init({
      providers: ["codex"],
      answers: ["n"],
    });
    expect(declined.usable).toBe("");
    expect(declined.out).toContain("was not enabled");
    expect(declined.out).toContain("not ready");
    expect(readConfig(declined.home)).toBeNull();
    expect(existsSync(join(declined.home, "oauth.json"))).toBe(false);

    const base = root();
    const token = writeCodexLogin(join(base, "codex"));
    const accepted = await init({
      base,
      providers: ["codex"],
      answers: ["y"],
      defaultProvider: "codex",
    });
    expect(accepted.prompts).toContain("Enable Codex subscription mode anyway?");
    expect(accepted.usable).toBe("codex");
    expect(readConfig(accepted.home)).toMatchObject({
      authMode: "subscription",
      acknowledgedTosRisk: true,
      preference: "subscription",
    });
    expect(accepted.out).toContain(
      "ready — OpenAI/Codex subscription (opt-in), preference subscription.",
    );
    expect(accepted.out).toContain("Remote authentication was not rechecked.");
    expect(accepted.out).not.toContain("Waiting for authorization");
    expect(existsSync(join(accepted.home, "oauth.json"))).toBe(false);
    assertHidden(`${accepted.prompts}\n${accepted.out}`, [token, ACCOUNT, REFRESH]);
  });

  it("preserves an existing key and still forces api_key when Codex was already enabled", async () => {
    envWrites.length = 0;
    const base = root();
    const home = join(base, "profile");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(base, ".env"), `OPENROUTER_API_KEY=${OPENROUTER_KEY}\nOTHER=keep\n`, "utf8");
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        openai: {
          auth_mode: "subscription",
          acknowledged_tos_risk: true,
          preference: "subscription",
        },
      }),
    );
    const run = await init({
      base,
      providers: ["openrouter", "anthropic", "codex"],
      answers: [ANTHROPIC_KEY],
      defaultProvider: "anthropic",
      environment: { OPENROUTER_API_KEY: OPENROUTER_KEY },
    });
    expect(run.prompts).not.toContain("OPENROUTER_API_KEY (hidden");
    expect(run.prompts).not.toContain("Enable Codex subscription mode anyway?");
    expect(run.usable).toBe("anthropic,openrouter");
    expect(envWrites).toEqual([{ ANTHROPIC_API_KEY: ANTHROPIC_KEY, LOHRA_PROVIDER: "anthropic" }]);
    const saved = readFileSync(join(base, ".env"), "utf8");
    expect(saved).toContain(`OPENROUTER_API_KEY=${OPENROUTER_KEY}`);
    expect(saved).toContain("OTHER=keep");
    expect(saved).toContain(`ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`);
    expect(readConfig(home)).toMatchObject({
      authMode: "subscription",
      acknowledgedTosRisk: true,
      preference: "api_key",
    });
    expect(run.out).not.toContain(OPENROUTER_KEY);
    expect(run.out).not.toContain(ANTHROPIC_KEY);
    expect(run.prompts).not.toContain(OPENROUTER_KEY);
    expect(run.prompts).not.toContain(ANTHROPIC_KEY);
  });

  it("reports a save failure without a success marker or a printed key", async () => {
    const base = root();
    mkdirSync(join(base, ".env"));
    const run = await init({
      base,
      providers: ["openrouter"],
      answers: [OPENROUTER_KEY],
      defaultProvider: "openrouter",
    });
    expect(run.result).toBe(2);
    expect(run.prompts).toContain("failed to save init configuration");
    expect(markerPresent(run.home)).toBe(false);
    expect(run.out).not.toContain("ready — provider");
    assertHidden(run.prompts, [OPENROUTER_KEY]);
  });

  it("does not write a success marker when skill install fails", async () => {
    const base = root();
    const client = listSkillClients({ HOME: base }, { platform: "linux", systemHome: base }).find(
      (item) => item.id === "opencode",
    );
    if (!client) throw new Error("missing opencode");
    const edited = join(client.skillsDirectory, "use-lohra-ts", "SKILL.md");
    mkdirSync(join(client.skillsDirectory, "use-lohra-ts"), { recursive: true });
    writeFileSync(edited, "local edit");
    const run = await init({
      base,
      providers: ["anthropic"],
      answers: [ANTHROPIC_KEY],
      defaultProvider: "anthropic",
      environment: { HOME: base },
      chooseClients: () => Promise.resolve([client]),
    });
    expect(run.result).toBe(2);
    expect(readFileSync(edited, "utf8")).toBe("local edit");
    expect(markerPresent(run.home)).toBe(false);
    expect(run.prompts).toContain("failed to install use-lohra-ts for OpenCode");
    expect(run.out).toContain("skill install failed; the init success marker was not written.");
    expect(run.out).not.toContain(ANTHROPIC_KEY);
  });

  it("writes nothing when a question is cancelled", async () => {
    const base = root();
    const home = join(base, "profile");
    await expect(
      runInit({
        snapshot: snapshot(home),
        base,
        home,
        codexHome: join(base, "codex"),
        environment: { HOME: base },
        noInput: false,
        isTty: true,
        prompter: new Prompter(
          () => {
            throw new TerminalInputError("terminal input cancelled; configuration interrupted");
          },
          () => undefined,
        ),
        writeOut: () => undefined,
        chooseProviders: () => Promise.resolve(["openrouter", "anthropic"]),
        chooseDefault: () => Promise.resolve("openrouter"),
        chooseClients: () => Promise.resolve([]),
      }),
    ).rejects.toBeInstanceOf(TerminalInputError);
    expect(existsSync(join(base, ".env"))).toBe(false);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    expect(markerPresent(home)).toBe(false);
  });

  it("refuses to replace a stored key", () => {
    const base = root();
    const home = join(base, "profile");
    const environment = { OPENROUTER_API_KEY: OPENROUTER_KEY };
    expect(() =>
      persistProviderPlan({
        base,
        home,
        environment,
        subscriptionAlreadyActive: false,
        plan: {
          selected: ["openrouter"],
          keys: { OPENROUTER_API_KEY: "replacement-fixture-key-939" },
          codexConsent: false,
          defaultProvider: "openrouter",
        },
      }),
    ).toThrow("refusing to replace existing OPENROUTER_API_KEY");
    expect(existsSync(join(base, ".env"))).toBe(false);
    expect(environment.OPENROUTER_API_KEY).toBe(OPENROUTER_KEY);
  });
});
