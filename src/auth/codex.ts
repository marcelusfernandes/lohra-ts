import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { CodexTokens } from "./types.js";

const MAX_BYTES = 1_000_000;
// O `models_cache.json` do Codex traz instruções por modelo e já passa de
// 450 KB (codex-cli 0.165.0); o teto dele é maior, mas continua limitado.
const CATALOG_MAX_BYTES = 16_000_000;
const text = (path: string, maxBytes: number = MAX_BYTES): string | null => {
  try {
    if (!existsSync(path) || statSync(path).size > maxBytes) return null;
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

const unquote = (raw: string): string | null => {
  const match = /^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(raw.trim());
  const value = match?.[1] ?? match?.[2] ?? null;
  return value === null || value.trim() === "" ? null : value;
};

/**
 * `model` que o usuário escolheu no `config.toml` do Codex (#998): o do
 * profile ativo (`profile = "x"` → `[profiles.x]`) vence o de topo. Um
 * `model` dentro de qualquer outra tabela não conta — o regex antigo pegava
 * o primeiro `model =` do arquivo, de qualquer tabela.
 */
export function readCodexModel(codexHome: string): string | null {
  const raw = text(join(codexHome, "config.toml"));
  if (raw === null) return null;
  const top = new Map<string, string>();
  const tables = new Map<string, Map<string, string>>();
  let current: Map<string, string> = top;
  for (const line of raw.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      const name = (header[1] ?? "").replace(/\s*\.\s*/g, ".").replace(/"/g, "");
      current = tables.get(name) ?? new Map<string, string>();
      tables.set(name, current);
      continue;
    }
    const pair = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (pair === null) continue;
    const value = unquote(pair[2] ?? "");
    if (value !== null && !current.has(pair[1] ?? "")) current.set(pair[1] ?? "", value);
  }
  const profile = top.get("profile");
  const fromProfile = profile === undefined ? undefined : tables.get(`profiles.${profile}`);
  return fromProfile?.get("model") ?? top.get("model") ?? null;
}

const priorityOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;

/**
 * Padrão do catálogo que o próprio Codex grava em `$CODEX_HOME/models_cache.json`
 * (`codex-rs/models-manager`, `default_model_from_available`): ordena por
 * `priority` e pega o primeiro visível no seletor (`visibility: "list"`);
 * sem nenhum visível, o primeiro. O Lohra só lê o arquivo, nunca o escreve.
 */
export function readCodexCatalogDefault(codexHome: string): string | null {
  const raw = text(join(codexHome, "models_cache.json"), CATALOG_MAX_BYTES);
  if (raw === null) return null;
  let root: unknown;
  try {
    root = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const models = (root as { readonly models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const entries = models
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).slug === "string" &&
        ((entry as Record<string, unknown>).slug as string).trim() !== "",
    )
    .map((entry, index) => ({
      slug: entry.slug as string,
      priority: priorityOf(entry.priority),
      visible: entry.visibility === "list",
      index,
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index);
  return (entries.find((entry) => entry.visible) ?? entries[0])?.slug ?? null;
}

/**
 * Modelo padrão da rota Codex, resolvido como o Codex CLI resolve (#998): o
 * que o usuário configurou, senão o padrão do catálogo do Codex. Sem nenhum
 * dos dois, `null` — quem chama recusa com `noCodexModelMessage`, nunca cai
 * num nome fixo.
 */
export function resolveCodexDefaultModel(codexHome: string): string | null {
  return readCodexModel(codexHome) ?? readCodexCatalogDefault(codexHome);
}

/** Mensagem acionável quando nenhum modelo do Codex é resolvível (#998). */
export function noCodexModelMessage(codexHome: string): string {
  return (
    "no Codex model to use: " +
    `${join(codexHome, "config.toml")} sets no \`model\` and ` +
    `${join(codexHome, "models_cache.json")} lists none. ` +
    'Pass --model <name>, set `model = "<name>"` in that config.toml, ' +
    "or run `codex` once so it writes its model catalog"
  );
}
