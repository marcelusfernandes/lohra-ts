import { applyEnvFile } from "../config/env-file.js";
import { resolvePaths } from "../config/paths.js";
import { pythonJsonDumps } from "../serialization/python-json.js";
import { renderChecks, runChecks } from "./checks.js";
import type { DoctorPayload, OllamaStatus } from "./model.js";
import { buildEnvironment, probeOllamaDown } from "./snapshot.js";

export interface DoctorOptions {
  readonly json: boolean;
  readonly environment: Record<string, string>;
  readonly probeOllama?: () => Promise<boolean | OllamaStatus>;
}

export async function runDoctor(
  options: DoctorOptions,
): Promise<{ readonly code: 0 | 2; readonly output: string }> {
  const paths = resolvePaths(options.environment);
  applyEnvFile(paths.envFile, options.environment);
  const probed = await (options.probeOllama ?? probeOllamaDown)();
  const ollama =
    typeof probed === "boolean"
      ? {
          alive: probed,
          detail: probed ? "" : "ConnectError",
          models: [] as readonly string[],
          url: "http://localhost:11434/api/tags",
        }
      : probed;
  const snapshot = buildEnvironment(options.environment, paths, ollama);
  const checks = runChecks(snapshot);
  const code = checks.some((check) => check.state === "fail") ? 2 : 0;
  const payload: DoctorPayload = { checks, environment: snapshot, exit_code: code, ok: code === 0 };
  return { code, output: options.json ? `${pythonJsonDumps(payload)}\n` : renderChecks(checks) };
}
