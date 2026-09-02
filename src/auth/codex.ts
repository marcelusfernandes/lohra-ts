import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { CodexTokens } from "./types.js";

const MAX_BYTES = 1_000_000;
const text = (path: string): string | null => {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export function readCodexTokens(codexHome: string): CodexTokens | null {
  const raw = text(join(codexHome, "auth.json"));
  if (raw === null) return null;
  try {
    const root = JSON.parse(raw) as unknown;
    if (typeof root !== "object" || root === null) return null;
    const tokens = (root as Record<string, unknown>).tokens;
    if (typeof tokens !== "object" || tokens === null) return null;
    const value = tokens as Record<string, unknown>;
    if (typeof value.access_token !== "string" || !value.access_token) return null;
    return new CodexTokens(
      value.access_token,
      typeof value.refresh_token === "string" ? value.refresh_token : "",
      typeof value.account_id === "string" && value.account_id ? value.account_id : null,
    );
  } catch {
    return null;
  }
}

export function readCodexModel(codexHome: string): string | null {
  const raw = text(join(codexHome, "config.toml"));
  if (raw === null) return null;
  const match = /^\s*model\s*=\s*["']([^"']+)["']\s*$/m.exec(raw);
  return match?.[1] || null;
}
