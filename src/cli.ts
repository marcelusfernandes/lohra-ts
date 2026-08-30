#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePaths } from "./config/paths.js";
import { applyEnvFile } from "./config/env-file.js";
import { runModels } from "./commands/models.js";
import { runTiers } from "./commands/tiers.js";
import { runDoctor } from "./doctor/index.js";
import type { OllamaStatus } from "./doctor/model.js";
import { probeOllamaDown } from "./doctor/snapshot.js";
import { pythonJsonDumps } from "./serialization/python-json.js";

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

export interface CliIo {
  readonly environment: Record<string, string>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly probeOllama?: () => Promise<boolean | OllamaStatus>;
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

function help(): string {
  return `usage: lohra [-h] [--version]\n             {${commands.join(",")}}\n             ...\n\nLohra AI agent\n\npositional arguments:\n  {${commands.join(",")}}\n\noptions:\n  -h, --help  show this help message and exit\n  --version   show program's version number and exit\n`;
}

function invalidOrder(value: string): string {
  const choices = commands.join(", ");
  return `usage: lohra [-h] [--version]\n             {${commands.join(",")}}\n             ...\nlohra: error: argument command: invalid choice: '${value}' (choose from ${choices})\n`;
}

function profileArgument(args: readonly string[]): string | undefined {
  const index = args.indexOf("--profile");
  return index < 0 ? undefined : args[index + 1];
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
  if (argv[0] === "--profile") {
    io.stderr(invalidOrder(argv[1] ?? ""));
    return 2;
  }
  const command = argv[0] as string;
  if (command !== "doctor" && command !== "models" && command !== "tiers") {
    if ((commands as readonly string[]).includes(command)) {
      io.stderr(`lohra: ${command} is not implemented in the TypeScript bootstrap\n`);
    } else {
      io.stderr(invalidOrder(command));
    }
    return 2;
  }

  const json = argv.includes("--json");
  const profile = profileArgument(argv);
  if (argv.includes("--profile") && profile === undefined) {
    io.stderr("lohra: error: argument --profile: expected one argument\n");
    return 2;
  }
  const environment = { ...io.environment };
  if (profile !== undefined) environment.LOHRA_PROFILE = profile;
  let paths;
  try {
    paths = resolvePaths(environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) io.stdout(`${pythonJsonDumps({ error: message })}\n`);
    io.stderr(`${message}\n`);
    return 2;
  }
  applyEnvFile(paths.envFile, environment);
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
  if (command === "models") {
    const providerIndex = argv.indexOf("--provider");
    const provider = providerIndex < 0 ? undefined : argv[providerIndex + 1];
    const result = await runModels({
      json,
      home: paths.home,
      environment,
      probeOllama: normalizeProbe,
      ...(provider === undefined ? {} : { provider }),
    });
    io.stdout(result.stdout);
    io.stderr(result.stderr);
    return result.code;
  }
  if (command === "tiers") {
    const result = await runTiers({
      action: argv[1] ?? "",
      noInput: argv.includes("--no-input"),
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
