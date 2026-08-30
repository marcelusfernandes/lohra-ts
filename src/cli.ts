#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePaths } from "./config/paths.js";
import { runDoctor } from "./doctor/index.js";
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
  readonly probeOllama?: () => Promise<boolean>;
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
  if (command !== "doctor") {
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
  try {
    resolvePaths(environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) io.stdout(`${pythonJsonDumps({ error: message })}\n`);
    io.stderr(`${message}\n`);
    return 2;
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
