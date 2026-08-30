import { readCodexTokens } from "./codex.js";
import { subscriptionActive } from "./credentials.js";
import { isExpired } from "./jwt.js";
import { readConfig, readTokens, writeConfig } from "./store.js";
import type { AuthPreference, SubscriptionConfig } from "./types.js";

export const PREFERENCES = ["auto", "subscription", "api_key"] as const;
export const TOS_WARNING =
  "⚠️  Subscription mode uses your ChatGPT/Codex subscription via your existing Codex CLI login.\n" +
  "    This very likely VIOLATES OpenAI's consumer Terms of Service and may get your account BANNED.\n" +
  "    The endpoints are reverse-engineered and can break without notice. Use at your own risk.\n" +
  "    Lohra reads (never writes) ~/.codex/auth.json; on an expired token it asks you to refresh via Codex.";

const fallback = (): SubscriptionConfig => ({
  authMode: "api_key",
  acknowledgedTosRisk: false,
  preference: "auto",
});

const switchMode = (
  home: string,
  authMode: string,
  acknowledgedTosRisk: boolean,
  stale: AuthPreference,
): void => {
  const current = readConfig(home) ?? fallback();
  writeConfig(home, {
    ...current,
    authMode,
    acknowledgedTosRisk,
    preference: current.preference === stale ? "auto" : current.preference,
  });
};

export const enable = (home: string): void => {
  switchMode(home, "subscription", true, "api_key");
};
export const disable = (home: string): void => {
  switchMode(home, "api_key", false, "subscription");
};

export function setPreference(home: string, value: string): void {
  if (!(PREFERENCES as readonly string[]).includes(value))
    throw new TypeError(`unknown auth preference '${value}'`);
  const current = readConfig(home) ?? fallback();
  writeConfig(home, { ...current, preference: value as AuthPreference });
}

export function status(
  home: string,
  options: { readonly codexHome: string; readonly now?: number },
): Record<string, unknown> {
  const config = readConfig(home);
  const own = readTokens(home);
  const codex = readCodexTokens(options.codexHome);
  const now = options.now ?? Date.now() / 1000;
  return {
    mode: config?.authMode ?? "api_key",
    active: subscriptionActive(home),
    preference: config?.preference ?? "auto",
    acknowledged_tos_risk: Boolean(config?.acknowledgedTosRisk),
    own_login: own !== null,
    own_login_expired: own === null ? null : own.expiresAt <= now,
    codex_login_found: codex !== null,
    codex_token_expired: codex === null ? null : isExpired(codex.accessToken, now),
    account_id: own?.accountId ?? codex?.accountId ?? null,
  };
}
