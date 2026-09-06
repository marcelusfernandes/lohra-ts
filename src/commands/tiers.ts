import { existsSync } from "node:fs";
import { buildCatalog } from "../catalog/catalog.js";
import type { OllamaStatus } from "../doctor/model.js";
import { loadTiers, MODEL_TIERS } from "../workflow/tiers.js";

export async function runTiers(options: {
  readonly action: string;
  readonly noInput: boolean;
  readonly home: string;
  readonly environment: Record<string, string>;
  readonly probeOllama: () => Promise<OllamaStatus>;
}): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const path = `${options.home}/workflow_tiers.json`;
  if (options.action === "list") {
    const tiers = loadTiers(path);
    if (Object.keys(tiers).length === 0) {
      return existsSync(path)
        ? {
            code: 1,
            stdout: `${path} — exists but no usable tier was loaded (broken JSON or unknown keys)\ninspect it with a JSON validator, e.g. jq . ${path}\n`,
            stderr: "",
          }
        : {
            code: 0,
            stdout: `${path} — not configured (a node's own model decides)\ncreate one from the real catalog: lohra tiers suggest\n`,
            stderr: "",
          };
    }
    const lines: string[] = [];
    for (const name of MODEL_TIERS) {
      const tier = tiers[name];
      if (tier)
        lines.push(
          `${name}: ${[tier.provider, tier.model, tier.effort].filter(Boolean).join("/")}`,
        );
    }
    return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }
  if (options.action !== "suggest")
    return { code: 2, stdout: "", stderr: `lohra tiers: unknown action '${options.action}'\n` };
  const catalog = await buildCatalog({
    environment: options.environment,
    probeOllama: options.probeOllama,
  });
  if (catalog.entries.every((entry) => entry.models.length === 0))
    return {
      code: 2,
      stdout: "nothing reachable to suggest from — check keys with: lohra models\n",
      stderr: "",
    };
  return {
    code: 2,
    stdout: "not written: no terminal to confirm — rerun with --yes to accept as-is\n",
    stderr: "",
  };
}
