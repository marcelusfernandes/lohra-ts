import { join } from "node:path";

import { promptSelect } from "../cli/terminal-select.js";
import type { TerminalInput } from "../cli/terminal-io.js";
import { enable, setPreference, status, TOS_WARNING } from "../auth/manage.js";
import { subscriptionActive } from "../auth/credentials.js";
import { readConfig } from "../auth/store.js";
import type { AuthPreference } from "../auth/types.js";
import { getProviderProfile } from "../providers/registry.js";
import { upsertEnvFile } from "./env-write.js";

export const PROVIDER_SELECTION_TITLE = "providers — arrows move, Space toggles, Enter confirms";
export const PROVIDER_SELECTION_HINT =
  "Mark Claude, Codex, and OpenRouter. Skill clients are chosen later.";
export const DEFAULT_PROVIDER_TITLE =
  "default provider — arrows move, Space selects, Enter confirms";
export const DEFAULT_PROVIDER_HINT =
  "Choose one usable route. A stored key is not a remote authentication check.";
export const CODEX_CONSENT_PROMPT = "Enable Codex subscription mode anyway?";

export type InitProviderId = "anthropic" | "codex" | "openrouter";

export const PROVIDER_CHOICES = [
  { id: "anthropic", label: "Claude (Anthropic API)" },
  { id: "codex", label: "Codex (subscription)" },
  { id: "openrouter", label: "OpenRouter" },
] as const satisfies readonly { readonly id: InitProviderId; readonly label: string }[];

const ALIASES: Readonly<Record<string, InitProviderId>> = {
  claude: "anthropic",
  anthropic: "anthropic",
  "anthropic api": "anthropic",
  "claude (anthropic api)": "anthropic",
  codex: "codex",
  subscription: "codex",
  "codex (subscription)": "codex",
  openrouter: "openrouter",
  or: "openrouter",
};

const KEY_ORDER = [
  ["openrouter", "OPENROUTER_API_KEY"],
  ["anthropic", "ANTHROPIC_API_KEY"],
] as const;

export type ProviderKeyVariable = (typeof KEY_ORDER)[number][1];

export interface CodexLoginView {
  readonly ownPresent: boolean;
  readonly ownUsable: boolean;
  readonly codexPresent: boolean;
  readonly codexUsable: boolean;
  readonly usable: boolean;
}

export interface ProviderPlan {
  readonly selected: readonly InitProviderId[];
  readonly keys: Readonly<Record<string, string>>;
  readonly codexConsent: boolean;
  readonly defaultProvider: InitProviderId | null;
}

export interface PersistedProviderState {
  readonly preference: AuthPreference | null;
  readonly subscriptionActive: boolean;
  readonly provider: string | null;
}

export async function promptInitProviders(options: {
  readonly terminal?: TerminalInput;
  readonly readLine: () => string | Promise<string>;
  readonly write: (text: string) => void;
}): Promise<readonly InitProviderId[]> {
  if (options.terminal) {
    return promptSelect({
      input: options.terminal,
      write: options.write,
      title: PROVIDER_SELECTION_TITLE,
      hint: PROVIDER_SELECTION_HINT,
      mode: "multiple",
      items: PROVIDER_CHOICES.map((choice) => ({
        id: choice.id,
        label: choice.label,
        value: choice.id,
      })),
    });
  }
  return providersFromLine(await options.readLine());
}

export async function promptInitDefault(options: {
  readonly terminal?: TerminalInput;
  readonly readLine: () => string | Promise<string>;
  readonly write: (text: string) => void;
  readonly usable: readonly InitProviderId[];
}): Promise<InitProviderId> {
  if (options.terminal) {
    const picked = await promptSelect({
      input: options.terminal,
      write: options.write,
      title: DEFAULT_PROVIDER_TITLE,
      hint: DEFAULT_PROVIDER_HINT,
      mode: "single",
      items: options.usable.map((id) => ({ id, label: providerLabel(id), value: id })),
    });
    const value = picked[0];
    if (value === undefined) throw new Error("choose one usable default provider");
    return value;
  }
  return defaultFromLine(await options.readLine(), options.usable);
}

export function providerLabel(id: InitProviderId): string {
  const choice = PROVIDER_CHOICES.find((item) => item.id === id);
  if (choice === undefined) throw new Error(`missing provider label for ${id}`);
  return choice.label;
}

export function isInitProviderId(value: unknown): value is InitProviderId {
  return value === "anthropic" || value === "codex" || value === "openrouter";
}

function tokenOf(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/gu, " ");
}

export function providersFromLine(answer: string): readonly InitProviderId[] {
  const selected: InitProviderId[] = [];
  for (const token of answer
    .split(",")
    .map(tokenOf)
    .filter((item) => item.length > 0)) {
    const id = ALIASES[token];
    if (id === undefined) {
      throw new Error(
        `unknown provider '${token}' — choose Claude (Anthropic API), Codex (subscription), or OpenRouter`,
      );
    }
    if (!selected.includes(id)) selected.push(id);
  }
  return selected;
}

export function normalizeProviders(ids: readonly unknown[]): readonly InitProviderId[] {
  const selected: InitProviderId[] = [];
  for (const id of ids) {
    if (!isInitProviderId(id)) {
      throw new Error(
        `unknown provider '${String(id)}' — choose Claude (Anthropic API), Codex (subscription), or OpenRouter`,
      );
    }
    if (!selected.includes(id)) selected.push(id);
  }
  return selected;
}

export function defaultFromLine(answer: string, usable: readonly InitProviderId[]): InitProviderId {
  const id = ALIASES[tokenOf(answer)];
  if (id === undefined || !usable.includes(id)) {
    throw new Error(`choose a usable default (${usable.join(", ") || "none"})`);
  }
  return id;
}

export function assertUsableDefault(
  value: unknown,
  usable: readonly InitProviderId[],
): InitProviderId {
  if (isInitProviderId(value) && usable.includes(value)) return value;
  throw new Error(`choose a usable default (${usable.join(", ") || "none"})`);
}

export function keyPrompt(variable: ProviderKeyVariable): string {
  return `${variable} (hidden, paste it, or Enter to skip)`;
}

export function keysToAsk(
  selected: readonly InitProviderId[],
  environment: Readonly<Record<string, string | undefined>>,
): readonly ProviderKeyVariable[] {
  const asked: ProviderKeyVariable[] = [];
  for (const [id, variable] of KEY_ORDER) {
    if (!selected.includes(id)) continue;
    if ((environment[variable] ?? "").trim()) continue;
    asked.push(variable);
  }
  return asked;
}

export function codexAlreadyEnabled(home: string): boolean {
  return subscriptionActive(home);
}

export function codexConsentIntro(alreadyEnabled: boolean): string {
  return alreadyEnabled
    ? "Codex subscription is already enabled (terms already accepted)."
    : TOS_WARNING;
}

export function readCodexLogin(home: string, codexHome: string): CodexLoginView {
  const value = status(home, { codexHome });
  const ownPresent = value.own_login === true;
  const ownUsable = ownPresent && value.own_login_expired === false;
  const codexPresent = value.codex_login_found === true;
  const codexUsable = codexPresent && value.codex_token_expired === false;
  return {
    ownPresent,
    ownUsable,
    codexPresent,
    codexUsable,
    usable: ownUsable || codexUsable,
  };
}

export function codexStatusText(options: {
  readonly enabled: boolean;
  readonly login: CodexLoginView;
}): string {
  if (!options.enabled) {
    return "Codex (subscription) was not enabled, so it is not a usable default.";
  }
  if (!options.login.usable) {
    return (
      "Codex (subscription) is pending: no valid local login. " +
      "It is not ready and is not a usable default. " +
      "Run `lohra auth login` for Lohra's own login, or `codex login` to reuse the Codex CLI login. " +
      "Init will not start that login."
    );
  }
  const source = options.login.ownUsable
    ? "Lohra login file present and not expired"
    : "Codex CLI login file present and not expired";
  return `Codex (subscription): ${source}. Remote authentication was not rechecked.`;
}

export function usableProviderIds(options: {
  readonly selected: readonly InitProviderId[];
  readonly anthropicKey: boolean;
  readonly openrouterKey: boolean;
  readonly codexEnabled: boolean;
  readonly loginUsable: boolean;
}): readonly InitProviderId[] {
  return PROVIDER_CHOICES.map((choice) => choice.id).filter((id) => {
    if (!options.selected.includes(id)) return false;
    switch (id) {
      case "anthropic":
        return options.anthropicKey;
      case "openrouter":
        return options.openrouterKey;
      case "codex":
        return options.codexEnabled && options.loginUsable;
      default: {
        const neverId: never = id;
        return neverId;
      }
    }
  });
}

export function configuredModel(
  provider: "anthropic" | "openrouter",
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const configured = (environment.LOHRA_MODEL ?? "").trim();
  if (configured) return configured;
  return getProviderProfile(provider)?.fallbackModels[0] ?? "";
}

function present(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  return (environment[name] ?? "").trim();
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    text = text.split(secret).join("[redacted]");
  }
  return text;
}

function envUpdates(options: {
  readonly environment: Readonly<Record<string, string>>;
  readonly plan: ProviderPlan;
}): Record<string, string> {
  const updates: Record<string, string> = {};
  for (const [, variable] of KEY_ORDER) {
    const value = (options.plan.keys[variable] ?? "").trim();
    if (!value) continue;
    const current = present(options.environment, variable);
    if (current && current !== value) {
      throw new Error(`refusing to replace existing ${variable}`);
    }
    if (current !== value) updates[variable] = value;
  }
  const chosen = options.plan.defaultProvider;
  if (chosen === "anthropic" || chosen === "openrouter") {
    if (present(options.environment, "LOHRA_PROVIDER") !== chosen) updates.LOHRA_PROVIDER = chosen;
  }
  return updates;
}

function assertSaved(options: {
  readonly home: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly plan: ProviderPlan;
  readonly optedIn: boolean;
}): PersistedProviderState {
  const config = readConfig(options.home);
  const active = subscriptionActive(options.home);
  const provider = present(options.environment, "LOHRA_PROVIDER") || null;
  const saved: PersistedProviderState = {
    preference: config?.preference ?? null,
    subscriptionActive: active,
    provider,
  };
  if (options.plan.defaultProvider === "codex") {
    if (saved.preference !== "subscription" || !saved.subscriptionActive) {
      throw new Error("saved Codex default does not match the auth files");
    }
  }
  if (
    options.plan.defaultProvider === "anthropic" ||
    options.plan.defaultProvider === "openrouter"
  ) {
    if (saved.provider !== options.plan.defaultProvider) {
      throw new Error("saved provider does not match the chosen default");
    }
    if (options.optedIn && saved.preference !== "api_key") {
      throw new Error("saved API default does not end with preference api_key");
    }
  }
  return saved;
}

/** Writes keys in one env update, then enable, then preference. API defaults call `setPreference("api_key")` last. */
export function persistProviderPlan(options: {
  readonly base: string;
  readonly home: string;
  readonly environment: Record<string, string>;
  readonly plan: ProviderPlan;
  readonly subscriptionAlreadyActive: boolean;
}): PersistedProviderState {
  const optedIn = options.plan.codexConsent || options.subscriptionAlreadyActive;
  const merged = { ...options.environment, ...options.plan.keys };
  if (options.plan.defaultProvider === "codex" && !optedIn) {
    throw new Error("Codex default requires an enabled subscription");
  }
  if (options.plan.defaultProvider === "anthropic" && !present(merged, "ANTHROPIC_API_KEY")) {
    throw new Error("Anthropic default requires ANTHROPIC_API_KEY");
  }
  if (options.plan.defaultProvider === "openrouter" && !present(merged, "OPENROUTER_API_KEY")) {
    throw new Error("OpenRouter default requires OPENROUTER_API_KEY");
  }
  const updates = envUpdates(options);
  if (Object.keys(updates).length > 0) upsertEnvFile(join(options.base, ".env"), updates);
  Object.assign(options.environment, updates);
  if (options.plan.codexConsent) enable(options.home);
  if (options.plan.defaultProvider === "codex") setPreference(options.home, "subscription");
  else if (
    optedIn &&
    (options.plan.defaultProvider === "anthropic" || options.plan.defaultProvider === "openrouter")
  ) {
    setPreference(options.home, "api_key");
  }
  return assertSaved({ ...options, optedIn });
}

export function renderProviderResult(options: {
  readonly selected: readonly InitProviderId[];
  readonly defaultProvider: InitProviderId | null;
  readonly persisted: PersistedProviderState;
  readonly keysPresent: { readonly anthropic: boolean; readonly openrouter: boolean };
  readonly login: CodexLoginView;
  readonly codexEnabled: boolean;
  readonly model: string;
  readonly installFailures: number;
}): string {
  const lines: string[] = [];
  if (options.selected.length === 0) lines.push("no providers selected.");
  for (const id of options.selected) lines.push(selectedLine(id, options));
  lines.push(outcomeLine(options));
  if (options.installFailures > 0) {
    lines.push("skill install failed; the init success marker was not written.");
  }
  return lines.join("\n");
}

function selectedLine(
  id: InitProviderId,
  options: {
    readonly keysPresent: { readonly anthropic: boolean; readonly openrouter: boolean };
    readonly login: CodexLoginView;
    readonly codexEnabled: boolean;
  },
): string {
  switch (id) {
    case "anthropic":
      return options.keysPresent.anthropic
        ? "Claude (Anthropic API): ANTHROPIC_API_KEY is set locally. Remote authentication was not checked."
        : "Claude (Anthropic API): ANTHROPIC_API_KEY is not set, so it is not a usable default.";
    case "openrouter":
      return options.keysPresent.openrouter
        ? "OpenRouter: OPENROUTER_API_KEY is set locally. Remote authentication was not checked."
        : "OpenRouter: OPENROUTER_API_KEY is not set, so it is not a usable default.";
    case "codex":
      return codexStatusText({ enabled: options.codexEnabled, login: options.login });
    default: {
      const neverId: never = id;
      return neverId;
    }
  }
}

function outcomeLine(options: {
  readonly defaultProvider: InitProviderId | null;
  readonly persisted: PersistedProviderState;
  readonly model: string;
}): string {
  if (options.defaultProvider === null) return "not ready — no usable default was chosen.";
  if (options.defaultProvider === "codex") {
    return (
      `ready — OpenAI/Codex subscription (opt-in), preference ${options.persisted.preference ?? "subscription"}. ` +
      "A local login is present; remote authentication was not rechecked."
    );
  }
  const preference =
    options.persisted.preference === "api_key"
      ? options.persisted.subscriptionActive
        ? ", preference api_key (Codex subscription stays opted in)"
        : ", preference api_key"
      : "";
  const model = options.model ? `, model ${options.model}` : "";
  return (
    `ready — provider ${options.defaultProvider}${model}${preference}. ` +
    "The API key is stored locally; remote authentication was not checked."
  );
}
