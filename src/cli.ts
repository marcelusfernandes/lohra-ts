#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePaths } from "./config/paths.js";
import { applyEnvFile } from "./config/env-file.js";
import { runModels } from "./commands/models.js";
import { runTiers } from "./commands/tiers.js";
import { runAuth } from "./commands/auth.js";
import { runChat } from "./commands/chat.js";
import { runCron } from "./commands/cron.js";
import { runServe } from "./commands/serve.js";
import { runWorkflowCommand } from "./commands/workflow.js";
import { runDashboard } from "./commands/dashboard.js";
import { runUpdate } from "./commands/update.js";
import { readCodexModel } from "./auth/codex.js";
import { subscriptionActive } from "./auth/credentials.js";
import type { OAuthPost } from "./auth/oauth.js";
import { runDoctor } from "./doctor/index.js";
import type { OllamaStatus } from "./doctor/model.js";
import { buildEnvironment, probeOllamaDown } from "./doctor/snapshot.js";
import { stringifyJsonPreservingNumbers } from "./serialization/json-numbers.js";
import { runProfile } from "./onboarding/profiles.js";
import {
  Prompter,
  runInit,
  type OnboardingHarness,
  type OnboardingSnapshot,
} from "./onboarding/wizard.js";
import { readExportable, writeExportable } from "./skills/export.js";
import {
  AUTH_SPEC,
  CHAT_SPEC,
  COMMAND_SUMMARY,
  CRON_SPEC,
  DASHBOARD_SPEC,
  DOCTOR_SPEC,
  INIT_SPEC,
  MODELS_SPEC,
  PROFILE_SPEC,
  SERVE_SPEC,
  SKILL_EXPORT_SPEC,
  SKILL_SPEC,
  SUBCOMMAND_HELP,
  TIERS_LIST_SPEC,
  TIERS_SPEC,
  TIERS_SUGGEST_SPEC,
  UPDATE_SPEC,
  WORKFLOW_AUDIT_SPEC,
  WORKFLOW_LIST_SPEC,
  WORKFLOW_SPEC,
  WORKFLOW_WATCH_SPEC,
  type CommandSpec,
} from "./cli/arg-spec.js";
import {
  classifyUnknownCommand,
  invalidTopLevelChoice,
  LEVELS,
  parseCommand,
  renderError,
  renderHelp,
  TOP_LEVEL,
  unexpectedArguments,
  type Level,
  type ParseResult,
} from "./cli/arg-validation.js";

const version = "0.0.11";
const commands = [
  "init",
  "doctor",
  "chat",
  "dashboard",
  "serve",
  "cron",
  "workflow",
  "models",
  "tiers",
  "profile",
  "auth",
  "skill",
  "update",
] as const;

const SPEC_BY_COMMAND: Readonly<
  Record<string, { readonly spec: CommandSpec; readonly level: Level }>
> = {
  init: { spec: INIT_SPEC, level: LEVELS.init },
  doctor: { spec: DOCTOR_SPEC, level: LEVELS.doctor },
  chat: { spec: CHAT_SPEC, level: LEVELS.chat },
  dashboard: { spec: DASHBOARD_SPEC, level: LEVELS.dashboard },
  cron: { spec: CRON_SPEC, level: LEVELS.cron },
  serve: { spec: SERVE_SPEC, level: LEVELS.serve },
  models: { spec: MODELS_SPEC, level: LEVELS.models },
  auth: { spec: AUTH_SPEC, level: LEVELS.auth },
  profile: { spec: PROFILE_SPEC, level: LEVELS.profile },
  update: { spec: UPDATE_SPEC, level: LEVELS.update },
};

interface HelpEntry {
  readonly spec: CommandSpec;
  readonly level: Level;
  readonly summary: string;
  readonly subcommands?: Readonly<Record<string, string>>;
}

// One entry per top-level command, read by `lohra <command> --help`. Unlike
// `SPEC_BY_COMMAND`, this also covers `workflow`, `tiers`, and `skill` —
// dispatcher commands whose own spec never reaches `resolveParse`'s generic
// branch but still needs a `--help` rendering of its own.
const HELP_BY_COMMAND: Readonly<Record<string, HelpEntry>> = {
  init: { spec: INIT_SPEC, level: LEVELS.init, summary: COMMAND_SUMMARY.init as string },
  doctor: { spec: DOCTOR_SPEC, level: LEVELS.doctor, summary: COMMAND_SUMMARY.doctor as string },
  chat: { spec: CHAT_SPEC, level: LEVELS.chat, summary: COMMAND_SUMMARY.chat as string },
  dashboard: {
    spec: DASHBOARD_SPEC,
    level: LEVELS.dashboard,
    summary: COMMAND_SUMMARY.dashboard as string,
  },
  serve: { spec: SERVE_SPEC, level: LEVELS.serve, summary: COMMAND_SUMMARY.serve as string },
  cron: {
    spec: CRON_SPEC,
    level: LEVELS.cron,
    summary: COMMAND_SUMMARY.cron as string,
    subcommands: SUBCOMMAND_HELP.cron,
  },
  workflow: {
    spec: WORKFLOW_SPEC,
    level: LEVELS.workflow,
    summary: COMMAND_SUMMARY.workflow as string,
    subcommands: SUBCOMMAND_HELP.workflow,
  },
  models: { spec: MODELS_SPEC, level: LEVELS.models, summary: COMMAND_SUMMARY.models as string },
  tiers: {
    spec: TIERS_SPEC,
    level: LEVELS.tiers,
    summary: COMMAND_SUMMARY.tiers as string,
    subcommands: SUBCOMMAND_HELP.tiers,
  },
  profile: {
    spec: PROFILE_SPEC,
    level: LEVELS.profile,
    summary: COMMAND_SUMMARY.profile as string,
    subcommands: SUBCOMMAND_HELP.profile,
  },
  auth: {
    spec: AUTH_SPEC,
    level: LEVELS.auth,
    summary: COMMAND_SUMMARY.auth as string,
    subcommands: SUBCOMMAND_HELP.auth,
  },
  skill: {
    spec: SKILL_SPEC,
    level: LEVELS.skill,
    summary: COMMAND_SUMMARY.skill as string,
    subcommands: SUBCOMMAND_HELP.skill,
  },
  update: { spec: UPDATE_SPEC, level: LEVELS.update, summary: COMMAND_SUMMARY.update as string },
};

export interface CliIo {
  readonly environment: Record<string, string>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly probeOllama?: () => Promise<boolean | OllamaStatus>;
  readonly isTty?: boolean;
  readonly readLine?: () => string;
  readonly oauthPost?: OAuthPost;
  readonly cwd?: string;
}

function defaultIo(): CliIo {
  return {
    environment: Object.fromEntries(
      Object.entries(process.env).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value]],
      ),
    ),
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function help(): string {
  const lines = [
    TOP_LEVEL.banner.trimEnd(),
    "",
    "Lohra AI agent.",
    "",
    "commands:",
    ...commands.map((name) => `  ${name.padEnd(12)}${COMMAND_SUMMARY[name] as string}`),
    "",
    "options:",
    "  --version           show the installed version",
  ];
  return `${lines.join("\n")}\n`;
}

/** Parses `rest` against `command`'s spec (or, for `tiers`/`skill`, first
 * resolves the required sub-action and then the matching nested spec),
 * reports any error with that level's own usage banner, and returns the
 * successful `ParseResult` otherwise. Returns `null` after already writing
 * the rejection to `io.stderr` and the caller should return exit code 2
 * immediately. */
function resolveParse(io: CliIo, command: string, rest: readonly string[]): ParseResult | null {
  if (command === "workflow") {
    const action = rest[0];
    const actions = ["list", "watch", "audit"] as const;
    if (!(actions as readonly string[]).includes(action ?? "")) {
      const outer = parseCommand(WORKFLOW_SPEC, rest);
      io.stderr(
        renderError(
          outer.error ?? { kind: "requiredMissing", name: "workflow_cmd" },
          LEVELS.workflow,
        ),
      );
      return null;
    }
    const childSpec =
      action === "list"
        ? WORKFLOW_LIST_SPEC
        : action === "watch"
          ? WORKFLOW_WATCH_SPEC
          : WORKFLOW_AUDIT_SPEC;
    const level =
      action === "list"
        ? LEVELS.workflowList
        : action === "watch"
          ? LEVELS.workflowWatch
          : LEVELS.workflowAudit;
    const inner = parseCommand(childSpec, rest.slice(1));
    if (inner.error !== null) {
      io.stderr(renderError(inner.error, level));
      return null;
    }
    if (inner.extras.length > 0) {
      io.stderr(unexpectedArguments(inner.extras));
      return null;
    }
    return inner;
  }
  if (command === "tiers" || command === "skill") {
    const isSkill = command === "skill";
    const validActions = isSkill ? (["export"] as const) : (["list", "suggest"] as const);
    const action = rest[0];
    if (!(validActions as readonly string[]).includes(action ?? "")) {
      const outer = parseCommand(isSkill ? SKILL_SPEC : TIERS_SPEC, rest);
      const destName = isSkill ? "skill_cmd" : "tiers_cmd";
      io.stderr(
        renderError(
          outer.error ?? { kind: "requiredMissing", name: destName },
          isSkill ? LEVELS.skill : LEVELS.tiers,
        ),
      );
      return null;
    }
    const childSpec = isSkill
      ? SKILL_EXPORT_SPEC
      : action === "list"
        ? TIERS_LIST_SPEC
        : TIERS_SUGGEST_SPEC;
    const level = isSkill
      ? LEVELS.skillExport
      : action === "list"
        ? LEVELS.tiersList
        : LEVELS.tiersSuggest;
    const inner = parseCommand(childSpec, rest.slice(1));
    if (inner.error !== null) {
      io.stderr(renderError(inner.error, level));
      return null;
    }
    if (inner.extras.length > 0) {
      io.stderr(unexpectedArguments(inner.extras));
      return null;
    }
    return inner;
  }
  const entry = SPEC_BY_COMMAND[command] as { readonly spec: CommandSpec; readonly level: Level };
  const parsed = parseCommand(entry.spec, rest);
  if (parsed.error !== null) {
    io.stderr(renderError(parsed.error, entry.level));
    return null;
  }
  if (parsed.extras.length > 0) {
    io.stderr(unexpectedArguments(parsed.extras));
    return null;
  }
  return parsed;
}

export async function runCli(argv: readonly string[], supplied?: CliIo): Promise<number> {
  const io = supplied ?? defaultIo();
  if (argv[0] === "--version") {
    io.stdout(`lohra ${version}\n`);
    return 0;
  }
  if (argv.length === 0) {
    io.stdout(`lohra ${version} — see \`lohra --help\`\n`);
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(help());
    return 0;
  }
  const command = argv[0] as string;
  if (
    command !== "doctor" &&
    command !== "models" &&
    command !== "tiers" &&
    command !== "auth" &&
    command !== "chat" &&
    command !== "serve" &&
    command !== "dashboard" &&
    command !== "init" &&
    command !== "profile" &&
    command !== "skill" &&
    command !== "workflow" &&
    command !== "cron" &&
    command !== "update"
  ) {
    if ((commands as readonly string[]).includes(command)) {
      io.stderr(`lohra: ${command} is not implemented in the TypeScript bootstrap\n`);
    } else {
      // classifyUnknownCommand scans for the first non-option-like token to
      // test against the known command names. Measured: `lohra --frobnicate`
      // (solo) -> unexpected argument; `lohra --profile foo` -> unknown
      // command "foo" (NOT "unexpected --profile"); `lohra --frobnicate
      // extra1 extra2` -> unknown command "extra1".
      const classification = classifyUnknownCommand(argv);
      io.stderr(
        classification.kind === "invalidChoice"
          ? invalidTopLevelChoice(classification.value, commands)
          : unexpectedArguments(classification.tokens),
      );
    }
    return 2;
  }

  if (argv[1] === "--help" || argv[1] === "-h") {
    const entry = HELP_BY_COMMAND[command] as HelpEntry;
    io.stdout(renderHelp(entry.level, entry.spec, entry.summary, entry.subcommands));
    return 0;
  }

  // Argument-shape rejection happens before the program does anything else
  // — no env/path resolution, no stdout envelope, even under --json.
  const parsed = resolveParse(io, command, argv.slice(1));
  if (parsed === null) return 2;

  const json = parsed.options.has("--json");
  const profileValue = parsed.options.get("--profile") as string | undefined;
  const environment = { ...io.environment };
  if (profileValue !== undefined) environment.LOHRA_PROFILE = profileValue;
  let paths;
  try {
    paths = resolvePaths(environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) io.stdout(`${stringifyJsonPreservingNumbers({ error: message })}\n`);
    io.stderr(`${message}\n`);
    return 2;
  }
  applyEnvFile(paths.envFile, environment);
  const codexHome = environment.CODEX_HOME?.trim() || join(environment.HOME ?? "", ".codex");
  const normalizeProbe = async (): Promise<OllamaStatus> => {
    const value = await (io.probeOllama ?? probeOllamaDown)();
    return typeof value === "boolean"
      ? {
          alive: value,
          detail: value ? "" : "ConnectError",
          models: [],
          url: "http://localhost:11434/api/tags",
        }
      : value;
  };
  if (command === "workflow") {
    const action = argv[1] as "list" | "watch" | "audit";
    const option = (name: string): unknown => parsed.options.get(name);
    return runWorkflowCommand({
      action,
      databasePath: join(paths.home, "state.db"),
      stdout: io.stdout,
      stderr: io.stderr,
      args: {
        ...(parsed.positionals[0] === undefined ? {} : { run_id: parsed.positionals[0] }),
        ...(parsed.options.has("--last") ? { last: true } : {}),
        ...(option("--poll") === undefined ? {} : { poll: option("--poll") }),
        ...(option("--limit") === undefined ? {} : { limit: option("--limit") }),
        ...(option("--node") === undefined ? {} : { node_id: option("--node") }),
        ...(option("--event") === undefined ? {} : { event_type: option("--event") }),
        ...(option("--sub-id") === undefined ? {} : { sub_id: option("--sub-id") }),
        ...(option("--segment-id") === undefined ? {} : { segment_id: option("--segment-id") }),
        ...(option("--attempt") === undefined ? {} : { attempt: option("--attempt") }),
        ...(option("--after-seq") === undefined ? {} : { after_seq: option("--after-seq") }),
        ...(option("--snapshot-seq") === undefined
          ? {}
          : { snapshot_seq: option("--snapshot-seq") }),
      },
    });
  }
  if (command === "profile") {
    const result = runProfile(parsed.positionals[0] as string, parsed.positionals[1], {
      base: paths.base,
      activeProfile: paths.profile,
    });
    io.stdout(result.stdout);
    io.stderr(result.stderr);
    return result.code;
  }
  if (command === "skill") {
    const name = parsed.positionals[0] as string;
    const destination = parsed.options.get("--to") as string | undefined;
    try {
      if (destination !== undefined) {
        io.stdout(`wrote ${writeExportable(name, destination)}\n`);
      } else {
        io.stdout(readExportable(name));
      }
      return 0;
    } catch (error) {
      io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  if (command === "init") {
    const ollama = await normalizeProbe();
    const doctor = buildEnvironment(environment, paths, ollama);
    const harnesses: OnboardingHarness[] = doctor.harnesses.map((value) => ({
      name: stringField(value.name),
      home: stringField(value.home),
      installed: value.installed === true,
      homePresent: value.home_present === true,
    }));
    const onboarding: OnboardingSnapshot = {
      activeProfile: doctor.active_profile,
      authPreference: doctor.auth_preference,
      authRoute: doctor.auth_route,
      detectedProvider: doctor.detected_provider,
      envFile: doctor.env_file,
      envFilePresent: doctor.env_file_present,
      harnesses,
      home: doctor.home,
      interactive: io.isTty ?? doctor.interactive,
      ollama: doctor.ollama,
      providerError: doctor.provider_error,
      providerOrigin: doctor.provider_origin,
      providerNames: doctor.providers.map((provider) => provider.provider),
      presentProviderVars: doctor.providers.flatMap((provider) => provider.present_vars),
      pythonSupported: doctor.python_supported,
      pythonVersion: doctor.python_version,
      subscriptionActive: doctor.subscription_active,
    };
    return runInit({
      snapshot: onboarding,
      base: paths.base,
      home: paths.home,
      environment,
      noInput: parsed.options.has("--no-input"),
      isTty: io.isTty ?? false,
      prompter: new Prompter(io.readLine ?? (() => ""), io.stderr),
      writeOut: io.stdout,
    });
  }
  if (command === "auth") {
    const action = parsed.positionals[0] as string;
    const rawValue = parsed.positionals[1];
    const result = await runAuth({
      action,
      ...(rawValue === undefined ? {} : { value: rawValue }),
      assumeYes: parsed.options.has("--yes"),
      noInput: parsed.options.has("--no-input"),
      home: paths.home,
      codexHome,
      isTty: io.isTty ?? false,
      ...(io.oauthPost === undefined ? {} : { post: io.oauthPost }),
    });
    io.stdout(result.stdout);
    io.stderr(result.stderr);
    return result.code;
  }
  if (command === "serve") {
    if (subscriptionActive(paths.home)) {
      io.stderr(
        "refusing to serve: subscription mode is active, and relaying your ChatGPT/Codex subscription through this server would expose it. Run `lohra auth disable` (or use an API key) to serve — this gate is unconditional, so `lohra auth prefer api_key` does NOT lift it.\n",
      );
      return 2;
    }
    const host = parsed.options.get("--host") as string | undefined;
    const port = parsed.options.get("--port") as string | undefined;
    const tools = parsed.options.get("--tools") as string | undefined;
    return await runServe({
      configuration: {
        host: host ?? "127.0.0.1",
        port: Number.parseInt(port ?? "8000", 10),
        insecure: parsed.options.has("--insecure"),
        tools: tools ?? "",
      },
      environment,
      stdout: io.stdout,
      stderr: io.stderr,
    });
  }
  if (command === "dashboard") {
    return runDashboard({
      argv,
      environment,
      home: paths.home,
      codexHome,
      cwd: io.cwd ?? process.cwd(),
      stderr: io.stderr,
    });
  }
  if (command === "chat") {
    const result = await runChat({
      input: parsed.positionals[0] as string,
      flags: parsed.options,
      environment,
      home: paths.home,
      codexHome,
      cwd: io.cwd ?? process.cwd(),
    });
    io.stdout(result.stdout);
    io.stderr(result.stderr);
    return result.code;
  }
  if (command === "cron") {
    const result = runCron({ argv, home: paths.home });
    io.stdout(result.stdout);
    io.stderr(result.stderr);
    return result.code;
  }
  if (command === "update") {
    return runUpdate({
      check: parsed.options.has("--check"),
      reinstall: parsed.options.has("--reinstall"),
      stdout: io.stdout,
      stderr: io.stderr,
    });
  }
  if (command === "models") {
    const provider = parsed.options.get("--provider") as string | undefined;
    const result = await runModels({
      json,
      home: paths.home,
      environment,
      probeOllama: normalizeProbe,
      subscriptionActive: subscriptionActive(paths.home),
      subscriptionModel: readCodexModel(codexHome) ?? "gpt-5.5",
      ...(provider === undefined ? {} : { provider }),
    });
    io.stdout(result.stdout);
    io.stderr(result.stderr);
    return result.code;
  }
  if (command === "tiers") {
    // The sub-action ("list"/"suggest") is the OUTER tiers_cmd positional,
    // already validated by resolveParse (which passed rest.slice(1) — not
    // this token — to the child spec); parsed.positionals here belongs to
    // that child spec and never contains it.
    const result = await runTiers({
      action: argv[1] as string,
      noInput: parsed.options.has("--no-input"),
      home: paths.home,
      environment,
      probeOllama: normalizeProbe,
    });
    io.stdout(result.stdout);
    io.stderr(result.stderr);
    return result.code;
  }
  const result = await runDoctor({
    json,
    environment,
    ...(io.probeOllama === undefined ? {} : { probeOllama: io.probeOllama }),
  });
  io.stdout(result.output);
  return result.code;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(resolve(fileURLToPath(import.meta.url)))
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
