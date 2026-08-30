import { applyEnvFile } from "../config/env-file.js";
import { resolvePaths } from "../config/paths.js";
import { pythonJsonDumps } from "../serialization/python-json.js";
import { renderChecks, runChecks } from "./checks.js";
import type { DoctorPayload } from "./model.js";
import { buildEnvironment, probeOllamaDown } from "./snapshot.js";

export interface DoctorOptions {
  readonly json: boolean;
  readonly environment: Record<string, string>;
  readonly probeOllama?: () => Promise<boolean>;
}

export async function runDoctor(
  options: DoctorOptions,
): Promise<{ readonly code: 0 | 2; readonly output: string }> {
  const paths = resolvePaths(options.environment);
  applyEnvFile(paths.envFile, options.environment);
  await (options.probeOllama ?? probeOllamaDown)();
  const snapshot = buildEnvironment(options.environment, paths);
  const checks = runChecks(snapshot);
  const code = checks.some((check) => check.state === "fail") ? 2 : 0;
  const payload: DoctorPayload = { checks, environment: snapshot, exit_code: code, ok: code === 0 };
  return { code, output: options.json ? `${pythonJsonDumps(payload)}\n` : renderChecks(checks) };
}
