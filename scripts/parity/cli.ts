#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { writeEvidence } from "./evidence.js";
import { errorMessage, HarnessError } from "./errors.js";
import { runScenario } from "./harness.js";
import { parseScenarioManifest } from "./manifest.js";

interface CliOptions {
  readonly manifestPath: string;
  readonly evidencePath?: string;
  readonly oracleWorkspace?: string;
  readonly stubPort?: number;
  readonly bindings: Readonly<Record<string, string>>;
}

function usage(): string {
  return "usage: npm run parity -- --manifest <path> [--evidence <path>] [--oracle-workspace <absolute>] [--stub-port <0-65535>] [--bind name=/absolute/path]";
}

function argumentValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new HarnessError("CLI_ARGUMENT", `${option} requires a value`);
  }
  return value;
}

export function parseCli(args: readonly string[]): CliOptions {
  let manifestPath: string | undefined;
  let evidencePath: string | undefined;
  let oracleWorkspace: string | undefined;
  let stubPort: number | undefined;
  const bindings: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--manifest") {
      manifestPath = argumentValue(args, index, option);
      index += 1;
    } else if (option === "--evidence") {
      evidencePath = argumentValue(args, index, option);
      index += 1;
    } else if (option === "--oracle-workspace") {
      oracleWorkspace = argumentValue(args, index, option);
      index += 1;
    } else if (option === "--stub-port") {
      const value = argumentValue(args, index, option);
      stubPort = Number(value);
      if (!Number.isInteger(stubPort) || stubPort < 0 || stubPort > 65_535) {
        throw new HarnessError("CLI_ARGUMENT", "--stub-port must be an integer from 0 to 65535");
      }
      index += 1;
    } else if (option === "--bind") {
      const binding = argumentValue(args, index, option);
      const separator = binding.indexOf("=");
      if (separator <= 0) {
        throw new HarnessError("CLI_ARGUMENT", "--bind must be name=/absolute/path");
      }
      bindings[binding.slice(0, separator)] = binding.slice(separator + 1);
      index += 1;
    } else {
      throw new HarnessError("CLI_ARGUMENT", `Unknown argument ${String(option)}`);
    }
  }
  if (manifestPath === undefined) {
    throw new HarnessError("CLI_ARGUMENT", usage());
  }
  return {
    manifestPath,
    ...(evidencePath === undefined ? {} : { evidencePath }),
    ...(oracleWorkspace === undefined ? {} : { oracleWorkspace }),
    ...(stubPort === undefined ? {} : { stubPort }),
    bindings,
  };
}

export function runCli(args: readonly string[]): number {
  try {
    const options = parseCli(args);
    const parsed = JSON.parse(readFileSync(resolve(options.manifestPath), "utf8")) as unknown;
    const manifest = parseScenarioManifest(parsed);
    const stubPort =
      options.stubPort ??
      (manifest.stub !== undefined &&
      manifest.stub.state !== "down" &&
      manifest.argv.includes("--provider")
        ? 0
        : undefined);
    const evidence = runScenario(manifest, {
      ...(options.oracleWorkspace === undefined
        ? {}
        : { oracleWorkspace: resolve(options.oracleWorkspace) }),
      ...(stubPort === undefined ? {} : { stubPort }),
      executables: options.bindings,
    });
    const evidencePath = resolve(options.evidencePath ?? `.parity-evidence/${manifest.id}.json`);
    writeEvidence(evidencePath, evidence, manifest);
    process.stdout.write(
      `${JSON.stringify({ scenario: manifest.id, verdict: evidence.verdict, evidence: evidencePath })}\n`,
    );
    return evidence.verdict === "match" ? 0 : 1;
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "UNEXPECTED";
    process.stderr.write(`parity harness error [${code}]: ${errorMessage(error)}\n`);
    return 2;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  process.exitCode = runCli(process.argv.slice(2));
}
