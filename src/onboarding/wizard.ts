import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getProviderProfile } from "../providers/registry.js";
import { writeExportable } from "../skills/export.js";
import { upsertEnvFile } from "./env-write.js";

export const MARKER_NAME = ".initialized";
export const MARKER_TEXT = "onboarding offered — re-run `lohra init` any time.\n";

const NO_PROVIDER_CONFIGURED = `no provider configured — there are three ways in:

  1. API key (paid, any provider)
       export ANTHROPIC_API_KEY=sk-...      # or OPENAI_API_KEY, OPENROUTER_API_KEY,
                                            # DEEPSEEK_API_KEY, GROQ_API_KEY,
                                            # TOGETHER_API_KEY, GEMINI_API_KEY
     Keys are also read from ~/.lohra/.env (one KEY=value per line), which is
     what the desktop app writes and what a Finder-launched app relies on.

  2. OpenAI/Codex subscription (no API key; opt-in, ToS-gray)
       lohra auth enable        # prints the ToS warning and asks for a yes
       lohra auth login         # Lohra's own login (auto-refreshing)

  3. Local models, keyless (nothing leaves the machine)
       ollama serve             # then, in another shell:
       lohra chat "oi" --provider ollama

Or name a provider explicitly with --provider <name>.

Not sure which? Run \`lohra init\` — it detects what this machine already has and
sets up the rest (it is read-only without a terminal, so it is safe in CI), or
\`lohra doctor\` for a read-only report with the exact command for each gap.`;

export interface OnboardingHarness {
  readonly name: string;
  readonly home: string;
  readonly installed: boolean;
  readonly homePresent: boolean;
}

export interface OnboardingSnapshot {
  readonly activeProfile: string | null;
  readonly authPreference: string;
  readonly authRoute: "api_key" | "subscription" | "unusable";
  readonly detectedProvider: string | null;
  readonly envFile: string;
  readonly envFilePresent: boolean;
  readonly harnesses: readonly OnboardingHarness[];
  readonly home: string;
  readonly interactive: boolean;
  readonly ollama: {
    readonly alive: boolean;
    readonly models: readonly string[];
    readonly url: string;
  };
  readonly providerError: string | null;
  readonly providerOrigin: string;
  readonly providerNames: readonly string[];
  readonly presentProviderVars: readonly string[];
  readonly pythonSupported: boolean;
  readonly pythonVersion: string;
  readonly subscriptionActive: boolean;
}

export class Prompter {
  constructor(
    private readonly reader: () => string,
    private readonly writer: (text: string) => void,
  ) {}

  private read(): string {
    try {
      return (this.reader() || "").trim();
    } catch {
      return "";
    }
  }

  ask(label: string, defaultValue = ""): string {
    try {
      this.writer(`${label} [${defaultValue || "skip"}]: `);
    } catch {
      // A broken prompt stream does not make onboarding fatal.
    }
    return this.read() || defaultValue;
  }

  confirm(label: string, defaultValue: boolean): boolean {
    try {
      this.writer(`${label} [${defaultValue ? "Y/n" : "y/N"}]: `);
    } catch {
      // A broken prompt stream does not make onboarding fatal.
    }
    const answer = this.read().toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    return defaultValue;
  }

  note(text: string): void {
    try {
      this.writer(`${text}\n`);
    } catch {
      // A broken prompt stream does not make onboarding fatal.
    }
  }
}

export function markerPath(home: string): string {
  return join(home, MARKER_NAME);
}

export function markerPresent(home: string): boolean {
  try {
    return existsSync(markerPath(home));
  } catch {
    return false;
  }
}

export function writeMarker(home: string): string {
  const path = markerPath(home);
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(path, MARKER_TEXT, { encoding: "utf8", mode: 0o666 });
  } catch {
    // The oracle deliberately treats marker persistence as non-fatal.
  }
  return path;
}

export function shouldOfferWizard(options: {
  readonly snapshot: OnboardingSnapshot;
  readonly environment: Readonly<Record<string, string>>;
  readonly providerArgument?: string;
  readonly jsonOutput?: boolean;
  readonly noInput?: boolean;
  readonly isStdinTty: boolean;
  readonly isStderrTty: boolean;
}): boolean {
  if (options.jsonOutput || options.noInput) return false;
  if ((options.environment.LOHRA_NO_WIZARD ?? "").trim()) return false;
  if (!options.isStdinTty || !options.isStderrTty) return false;
  if (markerPresent(options.snapshot.home)) return false;
  if (options.providerArgument && getProviderProfile(options.providerArgument) === null)
    return false;
  if (options.providerArgument && getProviderProfile(options.providerArgument) !== null)
    return false;
  return !(
    options.snapshot.detectedProvider ||
    options.snapshot.authRoute === "subscription" ||
    (options.snapshot.ollama.alive && options.snapshot.ollama.models.length > 0)
  );
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(13)}${value}`;
}

export function renderOnboardingReport(snapshot: OnboardingSnapshot): string {
  const provider = snapshot.providerError
    ? `error: ${snapshot.providerError}`
    : snapshot.detectedProvider
      ? `${snapshot.detectedProvider}  (from ${snapshot.providerOrigin})`
      : snapshot.presentProviderVars.length > 0
        ? `none detected (keys seen: ${snapshot.presentProviderVars.join(", ")})`
        : "none detected";
  const subscription = !snapshot.subscriptionActive
    ? "off"
    : snapshot.authRoute === "subscription"
      ? "active (OpenAI/Codex)"
      : `active, but preference=${snapshot.authPreference} — API keys are used`;
  const ollama = snapshot.ollama.alive
    ? `running — ${String(snapshot.ollama.models.length)} model(s): ${snapshot.ollama.models.join(", ") || "none pulled"}`
    : `not running (${snapshot.ollama.url})`;
  const harnesses = snapshot.harnesses
    .filter((harness) => harness.installed || harness.homePresent)
    .map((harness) => harness.name)
    .join(", ");
  return `${[
    "Lohra — environment",
    row(
      "python",
      `${snapshot.pythonVersion}${snapshot.pythonSupported ? "" : "  (unsupported: needs >=3.11,<3.14)"}`,
    ),
    row("home", `${snapshot.home}  (profile: ${snapshot.activeProfile ?? "none"})`),
    row(".env", `${snapshot.envFile}  (${snapshot.envFilePresent ? "found" : "not found"})`),
    row("provider", provider),
    row("subscription", subscription),
    row("ollama", ollama),
    row("harnesses", harnesses || "none found"),
  ].join("\n")}\n\n`;
}

export function evaluateOnboarding(
  snapshot: OnboardingSnapshot,
  environment: Readonly<Record<string, string>>,
): readonly [ready: boolean, message: string] {
  if (snapshot.authRoute === "unusable") {
    return [
      false,
      `not ready — preference=${snapshot.authPreference} but subscription mode is not usable.\n` +
        "  lohra auth login   # or take the key path: lohra auth prefer auto",
    ];
  }
  const provider = (environment.LOHRA_PROVIDER ?? "").trim() || snapshot.detectedProvider || "";
  if (!provider) {
    if (snapshot.authRoute === "subscription")
      return [true, "ready — OpenAI/Codex subscription (opt-in)."];
    if (snapshot.ollama.alive && snapshot.ollama.models.length > 0)
      return [
        true,
        `ready — provider ollama (local, keyless), model ${snapshot.ollama.models[0] ?? ""}.`,
      ];
    return [false, NO_PROVIDER_CONFIGURED];
  }
  const profile = getProviderProfile(provider);
  if (profile === null)
    return [false, `provider '${provider}' is selected but unknown — re-run \`lohra init\`.`];
  if (profile.requiresApiKey && !profile.envVars.some((name) => environment[name])) {
    const variable = profile.envVars[0] ?? "";
    return [
      false,
      `provider ${provider} is selected, but ${variable} is not set.\n` +
        `  export ${variable}=...   (or add it to ${snapshot.envFile}, or re-run \`lohra init\`)`,
    ];
  }
  if (provider === "ollama" && !snapshot.ollama.alive) {
    return [
      false,
      `provider ollama is selected, but no daemon answered at ${snapshot.ollama.url}.\n` +
        '  start it with:  ollama serve       then:  lohra chat "oi"',
    ];
  }
  const model = (environment.LOHRA_MODEL ?? "").trim() || profile.fallbackModels[0] || "";
  return [true, `ready — provider ${provider}${model ? `, model ${model}` : ""}.`];
}

export function runConfigure(options: {
  readonly snapshot: OnboardingSnapshot;
  readonly prompter: Prompter;
  readonly base: string;
  readonly environment: Record<string, string>;
  readonly writeOut: (text: string) => void;
}): string[] {
  const updates: Record<string, string> = {};
  const suggested =
    options.snapshot.detectedProvider || (options.snapshot.ollama.alive ? "ollama" : "");
  let chosen = options.prompter.ask(
    `provider (${options.snapshot.providerNames.join("/")})`,
    suggested,
  );
  if (chosen && !options.snapshot.providerNames.includes(chosen)) {
    options.prompter.note(`  unknown provider '${chosen}' — keeping ${suggested || "none"}.`);
    chosen = suggested;
  }
  if (chosen && chosen !== options.snapshot.detectedProvider) updates.LOHRA_PROVIDER = chosen;
  const profile = chosen ? getProviderProfile(chosen) : null;
  if (
    profile !== null &&
    profile.requiresApiKey &&
    !profile.envVars.some((name) => options.environment[name])
  ) {
    const variable = profile.envVars[0] as string;
    const key = options.prompter.ask(`${variable} (paste it, or Enter to skip)`);
    if (key) updates[variable] = key;
  } else if (profile !== null) {
    const current =
      (options.environment.LOHRA_MODEL ?? "").trim() || profile.fallbackModels[0] || "";
    const suggestedModel =
      current || (chosen === "ollama" ? (options.snapshot.ollama.models[0] ?? "") : "");
    const model = options.prompter.ask("default model", suggestedModel);
    if (model && model !== current) updates.LOHRA_MODEL = model;
  }
  const written = Object.keys(updates).length
    ? upsertEnvFile(join(options.base, ".env"), updates)
    : [];
  Object.assign(options.environment, updates);
  const present = options.snapshot.harnesses.filter(
    (harness) => harness.installed || harness.homePresent,
  );
  if (
    present.length > 0 &&
    options.prompter.confirm(
      `export the use-lohra kit to ${present.map((harness) => harness.name).join(", ")}?`,
      false,
    )
  ) {
    for (const harness of present) {
      const destination = join(harness.home, "skills");
      try {
        options.prompter.note(`  wrote ${writeExportable("use-lohra", destination)}`);
      } catch (error) {
        options.prompter.note(
          `  could not export to ${destination}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  options.writeOut(`${evaluateOnboarding(options.snapshot, options.environment)[1]}\n`);
  return written;
}

export function runInit(options: {
  readonly snapshot: OnboardingSnapshot;
  readonly base: string;
  readonly home: string;
  readonly environment: Record<string, string>;
  readonly noInput: boolean;
  readonly isTty: boolean;
  readonly prompter: Prompter;
  readonly writeOut: (text: string) => void;
}): number {
  options.writeOut(renderOnboardingReport(options.snapshot));
  if (options.noInput || !options.snapshot.interactive || !options.isTty) {
    options.writeOut(`${evaluateOnboarding(options.snapshot, options.environment)[1]}\n`);
    return 0;
  }
  runConfigure(options);
  writeMarker(options.home);
  return 0;
}
