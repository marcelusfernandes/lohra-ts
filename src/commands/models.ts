import { buildCatalog } from "../catalog/catalog.js";
import type { CatalogHttpClient } from "../catalog/catalog.js";
import type { OllamaStatus } from "../doctor/model.js";
import { getProviderProfile } from "../providers/registry.js";
import { pythonJsonDumpsInsertionOrder } from "../serialization/python-json.js";
import { loadTiers, MODEL_TIERS } from "../workflow/tiers.js";

export interface ModelsOptions {
  readonly json: boolean;
  readonly provider?: string;
  readonly home: string;
  readonly environment: Record<string, string>;
  readonly probeOllama: () => Promise<OllamaStatus>;
  readonly client?: CatalogHttpClient;
}
export async function runModels(
  options: ModelsOptions,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const wanted = (options.provider ?? "").trim().toLowerCase();
  if (wanted && getProviderProfile(wanted) === null && wanted !== "openai-codex") {
    const message = `unknown provider '${wanted}' — run \`lohra models\` to see them all`;
    return options.json
      ? {
          code: 2,
          stdout: `${pythonJsonDumpsInsertionOrder({ error: message, providers: [], tiers: {} })}\n`,
          stderr: "",
        }
      : { code: 2, stdout: "", stderr: `error: ${message}\n` };
  }
  const catalog = await buildCatalog({
    environment: options.environment,
    providers: wanted ? [wanted] : undefined,
    probeOllama: options.probeOllama,
    ...(options.client ? { client: options.client } : {}),
  });
  const tiers = loadTiers(`${options.home}/workflow_tiers.json`);
  if (options.json) {
    const tierPayload: Record<string, unknown> = {};
    for (const name of MODEL_TIERS) {
      const tier = tiers[name];
      if (tier) tierPayload[name] = tier;
    }
    return {
      code: 0,
      stdout: `${pythonJsonDumpsInsertionOrder({ providers: catalog.entries.map((entry) => entry.toJSON()), tiers: tierPayload })}\n`,
      stderr: "",
    };
  }
  const lines: string[] = [];
  let reachable = 0;
  for (const entry of catalog.entries) {
    const detail = entry.detail ? ` — ${entry.detail}` : "";
    lines.push(
      entry.total
        ? `${entry.provider} [${entry.source}] ${String(entry.total)} model(s)${detail}`
        : `${entry.provider} [${entry.source}]${detail || " — none"}`,
    );
    for (const model of entry.models) lines.push(`  ${model}`);
    reachable += entry.total;
  }
  lines.push(
    "",
    `${String(reachable)} model(s) reachable across ${String(catalog.entries.length)} provider(s)`,
  );
  if (Object.keys(tiers).length > 0) {
    lines.push("", "tiers (workflow_tiers.json):");
    for (const name of MODEL_TIERS) {
      const tier = tiers[name];
      if (tier)
        lines.push(
          `  ${name}: ${[tier.provider, tier.model, tier.effort].filter(Boolean).join("/")}`,
        );
    }
  }
  return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
