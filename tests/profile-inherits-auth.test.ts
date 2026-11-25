// Issue #999 (dogfood A3 da 0.1.1): o `lohra init` grava a rota escolhida
// (assinatura Codex, preferência) em `<base>/auth.json`, mas um profile novo
// lia só `<base>/profiles/<nome>/auth.json` — e a skill `use-lohra-ts` que o
// init instala manda rodar `lohra chat --profile ts-<projeto>`. Resultado:
// "no provider configured" logo depois do init. Agora um profile sem
// `auth.json` próprio herda o do base; um `auth.json` próprio continua
// isolando; o login OAuth próprio (`oauth.json`) nunca é herdado.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { disable, enable, setPreference, status } from "../src/auth/manage.js";
import { resolveAuthRoute, subscriptionActive } from "../src/auth/credentials.js";
import { readConfig, readTokens, writeConfig, writeTokens } from "../src/auth/store.js";
import { runCli } from "../src/cli.js";
import { profileBaseHome } from "../src/config/paths.js";
import { runProfile } from "../src/onboarding/profiles.js";
import { CODEX_PROVIDER } from "../src/providers/index.js";
import { NativeChatHttpPort } from "../src/transports/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function layout(): { readonly root: string; readonly base: string; readonly profile: string } {
  const root = mkdtempSync(join(tmpdir(), "lohra-999-"));
  roots.push(root);
  const base = join(root, ".lohra");
  const profile = join(base, "profiles", "ts-demo");
  mkdirSync(profile, { recursive: true });
  return { root, base, profile };
}

/** Init com Codex como padrão: assinatura ligada e preferência subscription. */
function initCodexDefault(base: string): void {
  enable(base);
  setPreference(base, "subscription");
}

describe("profileBaseHome (issue #999)", () => {
  it("reconhece <base>/profiles/<nome>", () => {
    expect(profileBaseHome(join("/x", ".lohra", "profiles", "ts-demo"))).toBe(join("/x", ".lohra"));
  });
  it("um home que não é de profile não tem base", () => {
    expect(profileBaseHome(join("/x", ".lohra"))).toBeNull();
    expect(profileBaseHome(join("/x", "outro", "ts-demo"))).toBeNull();
  });
});

describe("profile sem auth.json próprio herda o do base (issue #999)", () => {
  it("rota, assinatura e status refletem o que o init gravou no base", () => {
    const { base, profile } = layout();
    initCodexDefault(base);
    expect(existsSync(join(profile, "auth.json"))).toBe(false);
    expect(readConfig(profile)).toEqual(readConfig(base));
    expect(subscriptionActive(profile)).toBe(true);
    expect(resolveAuthRoute(profile).mode).toBe("subscription");
    expect(status(profile, { codexHome: join(base, "no-codex") })).toMatchObject({
      mode: "subscription",
      active: true,
      preference: "subscription",
    });
  });

  it("um auth.json próprio no profile isola: nada vem do base", () => {
    const { base, profile } = layout();
    initCodexDefault(base);
    writeConfig(profile, {
      authMode: "api_key",
      acknowledgedTosRisk: false,
      preference: "api_key",
    });
    expect(subscriptionActive(profile)).toBe(false);
    expect(resolveAuthRoute(profile).mode).toBe("api_key");
  });

  it("auth disable --profile grava override no profile e não toca o base", () => {
    const { base, profile } = layout();
    initCodexDefault(base);
    disable(profile);
    expect(subscriptionActive(profile)).toBe(false);
    expect(existsSync(join(profile, "auth.json"))).toBe(true);
    expect(subscriptionActive(base)).toBe(true);
    expect(readConfig(base)?.preference).toBe("subscription");
  });

  it("o login OAuth próprio do base (oauth.json) não é herdado", () => {
    const { base, profile } = layout();
    initCodexDefault(base);
    writeTokens(base, {
      accessToken: "base-access",
      refreshToken: "base-refresh",
      accountId: "acct-999",
      expiresAt: Date.now() / 1000 + 999_999,
    });
    expect(readTokens(base)).not.toBeNull();
    expect(readTokens(profile)).toBeNull();
  });

  it("lohra profile create diz que o profile herda, não que não herda", () => {
    const { base } = layout();
    initCodexDefault(base);
    const result = runProfile("create", "novo", { base, activeProfile: null });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("does NOT inherit");
    expect(result.stdout).toContain("inherits");
    expect(subscriptionActive(join(base, "profiles", "novo"))).toBe(true);
  });

  it("profile create avisa que o lohra auth login não é herdado", () => {
    const { base } = layout();
    initCodexDefault(base);
    const result = runProfile("create", "novo", { base, activeProfile: null });
    expect(result.stdout).toContain("lohra auth login");
    expect(result.stdout).toContain("is not inherited");
    expect(result.stdout).toContain("--profile novo");
    expect(result.stdout).toContain("codex login");
    expect(result.stdout).not.toContain("works right after setup");
  });
});

const jwt = (exp: number): string =>
  `x.${Buffer.from(JSON.stringify({ exp, chatgpt_account_id: "acct-999" })).toString("base64url")}.y`;

describe("lohra doctor --profile num profile que herda (issue #999)", () => {
  it("não avisa divergência e aponta o auth.json do base", async () => {
    const { root, base } = layout();
    initCodexDefault(base);
    const stdout: string[] = [];
    await runCli(["doctor", "--profile", "ts-demo", "--json"], {
      environment: { HOME: root, LOHRA_HOME: base, CODEX_HOME: join(root, ".codex") },
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      probeOllama: () => Promise.resolve(false),
    });
    const report = JSON.parse(stdout.join("")) as {
      checks: { name: string; state: string; detail: string }[];
      environment: { subscription_divergence: boolean };
    };
    expect(report.environment.subscription_divergence).toBe(false);
    const subscription = report.checks.find((check) => check.name === "subscription");
    expect(subscription?.detail).toContain(join(base, "auth.json"));
    expect(subscription?.detail).not.toContain(join(base, "profiles"));
    expect(report.checks.find((check) => check.name === "profile")?.state).toBe("ok");
  });
});

describe("lohra chat --profile ts-<projeto> logo depois do init (issue #999)", () => {
  it("usa a rota Codex do base em vez de 'no provider configured'", async () => {
    const { root, base } = layout();
    initCodexDefault(base);
    const codexHome = join(root, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: jwt(Math.floor(Date.now() / 1000) + 999_999),
          refresh_token: "r",
          account_id: "acct-999",
        },
      }),
    );
    const postSpy = vi
      .spyOn(NativeChatHttpPort.prototype, "post")
      .mockRejectedValue(new Error("999: sem rede em teste"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    await runCli(
      [
        "chat",
        "--profile",
        "ts-demo",
        "--json",
        "--no-input",
        "--no-tools",
        "--model",
        "gpt-999",
        "oi",
      ],
      {
        environment: { HOME: root, LOHRA_HOME: base, CODEX_HOME: codexHome },
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    );
    const envelope = JSON.parse(stdout.join("")) as { error: string | null; model: string | null };
    expect(envelope.error ?? "").not.toContain("no provider configured");
    expect(postSpy).toHaveBeenCalled();
    const request = postSpy.mock.calls[0]?.[0] as { readonly url: string };
    expect(request.url.startsWith(CODEX_PROVIDER.baseUrl)).toBe(true);
    expect(envelope.model).toBe("gpt-999");
  });
});

describe("lohra doctor --profile quando só o login próprio está no base (issue #999)", () => {
  it("aponta lohra auth login --profile e não trata o oauth do base como herdado", async () => {
    const { root, base } = layout();
    initCodexDefault(base);
    writeTokens(base, {
      accessToken: "base-access",
      refreshToken: "base-refresh",
      accountId: "acct-999",
      expiresAt: Date.now() / 1000 + 999_999,
    });
    const stdout: string[] = [];
    await runCli(["doctor", "--profile", "ts-demo", "--json"], {
      environment: { HOME: root, LOHRA_HOME: base, CODEX_HOME: join(root, "no-codex") },
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      probeOllama: () => Promise.resolve(false),
    });
    const report = JSON.parse(stdout.join("")) as {
      checks: { name: string; state: string; detail: string; remedy?: string }[];
    };
    const provider = report.checks.find((check) => check.name === "provider");
    expect(provider?.state).toBe("fail");
    expect(provider?.remedy ?? "").toContain("lohra auth login --profile ts-demo");
    expect(provider?.remedy ?? "").toContain("codex login");
    const login = report.checks.find((check) => check.name === "login");
    expect(login?.detail).toContain("per profile");
    expect(login?.detail).toContain("--profile ts-demo");
    expect(login?.detail).not.toContain("base-access");
  });
});

describe("skill e mensagens não prometem o login OAuth herdado (issue #999)", () => {
  it("use-lohra-ts não diz que o chat funciona logo depois do setup em qualquer login", () => {
    const skill = readFileSync(
      new URL("../assets/skills/use-lohra-ts/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(skill).not.toContain("so it works right after setup");
    expect(skill).toContain("lohra auth login");
    expect(skill).toContain("is not inherited");
    expect(skill).toContain("codex login");
    expect(skill).toContain("--profile ts-<project>");
  });

  it("README diz que o login próprio é por profile e não é herdado", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("lohra auth login");
    expect(readme).toContain("is not inherited");
    expect(readme).toContain("codex login");
  });
});
