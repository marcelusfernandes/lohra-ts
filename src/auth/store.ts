import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { jsonFloat, stringifyJsonPreservingNumbers } from "../serialization/json-numbers.js";
import { atomicWrite0600 } from "./json-file.js";
import {
  OAuthTokens,
  type AuthPreference,
  type OAuthTokensValue,
  type SubscriptionConfig,
} from "./types.js";

const MAX_BYTES = 1_000_000;
const preferences = new Set<AuthPreference>(["auto", "subscription", "api_key"]);

const bounded = (path: string): string | null => {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const authPath = (home: string): string => join(home, "auth.json");
export const tokenPath = (home: string): string => join(home, "oauth.json");

export function readConfig(home: string): SubscriptionConfig | null {
  const text = bounded(authPath(home));
  if (text === null) return null;
  try {
    const root = object(JSON.parse(text) as unknown);
    const entry = object(root?.openai);
    if (entry === null) return null;
    const rawPreference = entry.preference;
    return {
      authMode: typeof entry.auth_mode === "string" ? entry.auth_mode : "api_key",
      acknowledgedTosRisk: entry.acknowledged_tos_risk === true,
      preference:
        typeof rawPreference === "string" && preferences.has(rawPreference as AuthPreference)
          ? (rawPreference as AuthPreference)
          : "auto",
    };
  } catch {
    return null;
  }
}

export function writeConfig(home: string, config: SubscriptionConfig): void {
  let root: Record<string, unknown> = {};
  const text = bounded(authPath(home));
  if (text !== null) {
    try {
      root = object(JSON.parse(text) as unknown) ?? {};
    } catch {
      root = {};
    }
  }
  const entry = object(root.openai) ?? {};
  root.openai = {
    ...entry,
    auth_mode: config.authMode,
    acknowledged_tos_risk: config.acknowledgedTosRisk,
    preference: config.preference,
  };
  atomicWrite0600(authPath(home), stringifyJsonPreservingNumbers(root, 2));
}

export function readTokens(home: string): OAuthTokens | null {
  const text = bounded(tokenPath(home));
  if (text === null) return null;
  try {
    const data = object(JSON.parse(text) as unknown);
    if (data === null) return null;
    const access = data.access_token;
    if (typeof access !== "string" || access.length === 0) return null;
    return new OAuthTokens(
      access,
      typeof data.refresh_token === "string" ? data.refresh_token : "",
      typeof data.account_id === "string" ? data.account_id : null,
      Number(data.expires_at ?? 0),
    );
  } catch {
    return null;
  }
}

export function writeTokens(home: string, tokens: OAuthTokensValue): void {
  atomicWrite0600(
    tokenPath(home),
    stringifyJsonPreservingNumbers(
      {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: tokens.accountId,
        expires_at: jsonFloat(tokens.expiresAt),
      },
      2,
    ),
  );
}

export function clearTokens(home: string): boolean {
  try {
    unlinkSync(tokenPath(home));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
