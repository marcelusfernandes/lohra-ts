import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./canonical.js";
import { captureObservables } from "./capture.js";
import { compareRuns, readRunField } from "./compare.js";
import { errorMessage, HarnessError } from "./errors.js";
import {
  assertGuardAfter,
  assertGuardBefore,
  createGuardProvider,
  type GuardProvider,
} from "./guard.js";
import { runPythonProcess, runTypeScriptProcess } from "./process.js";
import { assertPreconditions, type TcpPortProbe } from "./preconditions.js";
import {
  expandArgument,
  resolveExecutable,
  resolveOracleWorkspace,
  type OracleWorkspace,
} from "./resolve.js";
import type {
  EvidenceRecord,
  FixtureSpec,
  NormalizationSpec,
  RunRecord,
  RunnerSpec,
  RuntimePaths,
  ScenarioManifest,
} from "./types.js";

const stubDriver = fileURLToPath(new URL("./stub/driver.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

export interface RunScenarioOptions {
  readonly cwd?: string;
  readonly projectRoot?: string;
  readonly oracleWorkspace?: string;
  readonly executables?: Readonly<Record<string, string>>;
  readonly pythonExecutable?: string;
  readonly guardProvider?: GuardProvider;
  readonly preconditionProbe?: TcpPortProbe;
}

const defaultProjectRoot = fileURLToPath(new URL("../..", import.meta.url));

function runtimePaths(root: string, side: "oracle" | "candidate"): RuntimePaths {
  const sideRoot = join(root, side);
  const paths = {
    root: sideRoot,
    home: join(sideRoot, "home"),
    profile: join(sideRoot, "profile"),
    sandbox: join(sideRoot, "sandbox"),
  };
  for (const path of Object.values(paths)) {
    mkdirSync(path, { recursive: true });
  }
  for (const path of [paths.home, paths.profile, paths.sandbox]) {
    if (!resolve(path).startsWith(`${resolve(sideRoot)}${sep}`)) {
      throw new HarnessError("ISOLATION_ESCAPE", `${path} escaped the temporary execution root`);
    }
  }
  mkdirSync(join(paths.home, "tmp"), { recursive: true });
  return paths;
}

function fixtureRoot(paths: RuntimePaths, fixture: FixtureSpec): string {
  return paths[fixture.root];
}

function materializeFixtures(paths: RuntimePaths, fixtures: readonly FixtureSpec[]): void {
  for (const fixture of fixtures) {
    const root = fixtureRoot(paths, fixture);
    const target = resolve(root, fixture.path);
    if (!target.startsWith(`${resolve(root)}${sep}`)) {
      throw new HarnessError("FIXTURE_ESCAPE", `Fixture ${fixture.path} escaped ${fixture.root}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    const content =
      fixture.encoding === "utf8"
        ? Buffer.from(fixture.content)
        : Buffer.from(fixture.content, "base64");
    writeFileSync(target, content);
  }
}

function environment(
  manifest: ScenarioManifest,
  paths: RuntimePaths,
  projectRoot: string,
): Readonly<Record<string, string>> {
  const inherited = Object.fromEntries(
    manifest.environment.allow.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const declared = Object.fromEntries(
    Object.entries(manifest.environment.set).map(([key, value]) => {
      const usesRuntimePath = value.includes("{{home}}") || value.includes("{{profile}}");
      const expanded = expandArgument(value, projectRoot)
        .replaceAll("{{home}}", paths.home)
        .replaceAll("{{profile}}", paths.profile);
      if (usesRuntimePath) {
        const absolute = resolve(expanded);
        const sideRoot = resolve(paths.root);
        if (absolute !== sideRoot && !absolute.startsWith(`${sideRoot}${sep}`)) {
          throw new HarnessError(
            "ISOLATION_ESCAPE",
            `environment.set.${key} escaped the temporary execution root`,
          );
        }
      }
      return [key, expanded];
    }),
  );
  return {
    ...inherited,
    ...declared,
    HOME: paths.home,
    LOHRA_PARITY_PROFILE: paths.profile,
  };
}

function commandArgs(
  runner: RunnerSpec,
  manifest: ScenarioManifest,
  projectRoot: string,
): string[] {
  return [...runner.prefixArgs, ...manifest.argv].map((value) =>
    expandArgument(value, projectRoot),
  );
}

function executeSide(
  side: "oracle" | "candidate",
  manifest: ScenarioManifest,
  paths: RuntimePaths,
  context: {
    readonly projectRoot: string;
    readonly workspace?: OracleWorkspace;
    readonly bindings?: Readonly<Record<string, string>>;
    readonly pythonExecutable: string;
  },
): RunRecord {
  const runner = manifest.runners[side];
  const executable = resolveExecutable(runner.executable, {
    ...(context.workspace === undefined ? {} : { oracle: context.workspace }),
    ...(context.bindings === undefined ? {} : { bindings: context.bindings }),
  });
  const target = {
    executable,
    argv: commandArgs(runner, manifest, context.projectRoot),
    cwd: paths[runner.cwd],
    environment: environment(manifest, paths, context.projectRoot),
  };
  let request = {
    ...target,
    ...manifest.limits,
  };
  if (manifest.stub !== undefined) {
    const configPath = join(paths.root, "stub-driver.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        scenario: manifest.id,
        side,
        stub: manifest.stub,
        limits: manifest.limits,
        target,
        logs: {
          projected: join(paths.profile, "stub-requests.jsonl"),
          raw: join(paths.profile, "stub-requests-raw.jsonl"),
          summary: join(paths.profile, "stub-summary.json"),
          assertions: join(paths.profile, "stub-assertions.json"),
        },
      }),
    );
    request = {
      executable: process.execPath,
      argv: ["--import", tsxLoader, stubDriver, configPath],
      cwd: paths.root,
      environment: { PATH: "/usr/bin:/bin" },
      timeoutMs: manifest.limits.timeoutMs + 1_000,
      maxOutputBytes: manifest.limits.maxOutputBytes,
    };
  }
  const processRecord =
    runner.adapter === "python"
      ? runPythonProcess(request, { pythonExecutable: context.pythonExecutable })
      : runTypeScriptProcess(request);
  if (manifest.stub !== undefined && processRecord.exitCode === 86) {
    throw new HarnessError("STUB_BIND_FAILED", "Stub could not bind 127.0.0.1:11434");
  }
  if (manifest.stub !== undefined) {
    assertPreconditions(manifest.preconditions, manifest.limits);
  }
  if (manifest.stub !== undefined && processRecord.exitCode === 87) {
    throw new HarnessError("STUB_DRIVER_FAILED", "Stub driver failed before target completion");
  }
  if (manifest.stub !== undefined && processRecord.exitCode === 88) {
    throw new HarnessError("PROCESS_TIMEOUT", "Stub target exceeded limits.timeoutMs");
  }
  if (manifest.stub !== undefined && processRecord.exitCode === 89) {
    throw new HarnessError("PROCESS_OUTPUT_LIMIT", "Stub target exceeded limits.maxOutputBytes");
  }
  return { process: processRecord, ...captureObservables(paths, manifest.capture) };
}

function setRunField(record: RunRecord, field: string, value: unknown): void {
  let current = record as unknown as Record<string, unknown>;
  const parts = field.split(".");
  for (const part of parts.slice(0, -1)) {
    current = current[part] as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (last !== undefined) {
    current[last] = structuredClone(value);
  }
}

function reproducibility(
  base: Omit<EvidenceRecord, "reproducibility">,
): EvidenceRecord["reproducibility"] {
  const projectedRuns = structuredClone(base.runs) as {
    oracle: RunRecord;
    candidate: RunRecord;
  };
  const excludedRawPointers: string[] = [];
  const comparedFields = new Set(Object.keys(base.comparison.normalized));
  for (const field of ["process.stdout", "process.stderr"] as const) {
    if (comparedFields.has(field)) continue;
    for (const side of ["oracle", "candidate"] as const) {
      setRunField(projectedRuns[side], field, "");
      excludedRawPointers.push(`/runs/${side}/${field.replaceAll(".", "/")}`);
    }
  }
  for (const event of base.capturePolicy.events.filter(
    (entry) => entry.projection === "raw-only",
  )) {
    for (const side of ["oracle", "candidate"] as const) {
      setRunField(projectedRuns[side], `events.${event.name}`, {
        exists: projectedRuns[side].events[event.name]?.exists ?? false,
      });
      excludedRawPointers.push(`/runs/${side}/events/${event.name}`);
    }
  }
  for (const sqlite of base.capturePolicy.sqlite.filter(
    (entry) => entry.projection === "raw-only",
  )) {
    for (const side of ["oracle", "candidate"] as const) {
      setRunField(projectedRuns[side], `sqlite.${sqlite.name}`, {
        exists: projectedRuns[side].sqlite[sqlite.name]?.exists ?? false,
      });
      excludedRawPointers.push(`/runs/${side}/sqlite/${sqlite.name}`);
    }
  }
  for (const rule of base.normalizationPolicy) {
    for (const side of ["oracle", "candidate"] as const) {
      setRunField(projectedRuns[side], rule.field, base.comparison.normalized[rule.field]?.[side]);
      excludedRawPointers.push(`/runs/${side}/${rule.field.replaceAll(".", "/")}`);
    }
  }
  const projection = { ...base, runs: projectedRuns };
  return {
    excludedRawPointers,
    projectionSha256: sha256(
      scrubHashOnlyContent(canonicalJson(projection), base.normalizationPolicy),
    ),
  };
}

/**
 * Post-verdict-only stabilization of the HASHED projection text. The
 * verdict has already been decided by compareRuns (compare.ts) by the time
 * this runs, so this can never mask a genuine oracle/candidate divergence —
 * it only keeps the hash from drifting on content that's supposed to be
 * identical across both sides (e.g. today's date) but isn't guaranteed to
 * land in comparison.normalized already-stabilized.
 *
 * compareRuns applies each hashOnly rule to comparison.normalized[field],
 * but that's not the only place a hashOnly-covered field's raw content
 * reaches the hash: comparison.differences intentionally keeps the
 * PRE-hashOnly value (so a human can see what actually diverged) for any
 * field that's genuinely divergent for an unrelated reason, and a scenario
 * can legitimately have no hashOnly rule registered for a field at all
 * (e.g. one side never produces it). Rather than enumerate every such path,
 * this reapplies each hashOnly pattern globally over the already-serialized
 * projection text: a suite with zero hashOnly rules gets zero
 * substitutions (a no-op by construction), and a suite that has one gets
 * its blast radius covered wherever the pattern appears in the hash input,
 * not just the one field/path it was declared against.
 *
 * Deliberately does NOT reuse replaceRegex/applyRule from compare.ts: those
 * throw on zero matches (expected here — most scenarios have none) or on
 * more than 16 (a pattern can legitimately recur across every request in a
 * conversation). Restricted to patterns whose match/replacement text is
 * plain ASCII with no character that JSON would escape, so operating on
 * the canonical-JSON string directly (instead of the pre-serialization
 * object) is safe.
 */
function scrubHashOnlyContent(
  serialized: string,
  normalizationPolicy: readonly NormalizationSpec[],
): string {
  let result = serialized;
  for (const rule of normalizationPolicy) {
    if (rule.kind !== "replace-regex" || rule.hashOnly !== true) continue;
    result = result.replaceAll(new RegExp(rule.pattern, "gu"), rule.replacement);
  }
  return result;
}

function expectationFailures(
  manifest: ScenarioManifest,
  runs: { readonly oracle: RunRecord; readonly candidate: RunRecord },
): EvidenceRecord["expectations"]["failures"] {
  const failures: EvidenceRecord["expectations"]["failures"][number][] = [];
  for (const expectation of manifest.expectations) {
    const sides =
      expectation.side === "both"
        ? (["oracle", "candidate"] as const)
        : ([expectation.side] as const);
    for (const side of sides) {
      const raw = readRunField(runs[side], expectation.field);
      let actual: unknown =
        expectation.encoding === "utf8" && typeof raw === "string"
          ? Buffer.from(raw, "base64").toString("utf8")
          : raw;
      if (expectation.pointer !== undefined) {
        if (expectation.encoding === "utf8" && typeof actual === "string") {
          try {
            actual = JSON.parse(actual) as unknown;
          } catch (error) {
            throw new HarnessError(
              "EXPECTATION_JSON",
              `Expectation field ${expectation.field} is not valid JSON`,
              { cause: error },
            );
          }
        }
        for (const part of expectation.pointer
          .slice(1)
          .split("/")
          .map((entry) => entry.replaceAll("~1", "/").replaceAll("~0", "~"))) {
          if (typeof actual !== "object" || actual === null || !(part in actual)) {
            throw new HarnessError(
              "EXPECTATION_POINTER",
              `Expectation pointer ${expectation.pointer} is missing in ${expectation.field}`,
            );
          }
          actual = (actual as Record<string, unknown>)[part];
        }
      }
      if (canonicalJson(actual) !== canonicalJson(expectation.value)) {
        failures.push({
          side,
          field: expectation.field,
          expected: expectation.value,
          actual,
        });
      }
    }
  }
  return failures;
}

export function runScenario(
  manifest: ScenarioManifest,
  options: RunScenarioOptions = {},
): EvidenceRecord {
  const preconditions = assertPreconditions(
    manifest.preconditions,
    manifest.limits,
    options.preconditionProbe,
  );
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const usesPythonAdapter = Object.values(manifest.runners).some(
    (runner) => runner.adapter === "python",
  );
  const needsWorkspace =
    (manifest.oracleGuard !== undefined && options.guardProvider === undefined) ||
    (usesPythonAdapter && options.pythonExecutable === undefined) ||
    Object.values(manifest.runners).some(
      (runner) => runner.executable === "oracle-lohra" || runner.executable === "oracle-python",
    );
  const workspace = needsWorkspace
    ? resolveOracleWorkspace({
        cwd,
        ...(options.oracleWorkspace === undefined
          ? {}
          : { explicitWorkspace: options.oracleWorkspace }),
        ...manifest.limits,
      })
    : undefined;
  const pythonExecutable = options.pythonExecutable ?? workspace?.python ?? "";
  if (usesPythonAdapter && pythonExecutable.length === 0) {
    throw new HarnessError(
      "PYTHON_BINDING",
      "Python adapter has no sanctioned interpreter binding",
    );
  }
  const guard =
    manifest.oracleGuard === undefined
      ? undefined
      : (options.guardProvider ??
        createGuardProvider(workspace as OracleWorkspace, manifest.limits));
  const root = mkdtempSync(join(tmpdir(), "lohra-parity-"));
  const oraclePaths = runtimePaths(root, "oracle");
  const candidatePaths = runtimePaths(root, "candidate");
  let beforeCommit: string | undefined;
  let beforePythonVersion: string | undefined;
  let beforePackages: Readonly<Record<string, string>> | undefined;
  let primaryError: unknown;
  let afterError: unknown;
  let oracleRun: RunRecord | undefined;
  let candidateRun: RunRecord | undefined;
  try {
    if (guard !== undefined && manifest.oracleGuard !== undefined) {
      const before = guard.before();
      assertGuardBefore(before, manifest.oracleGuard);
      beforeCommit = before.commit;
      beforePythonVersion = before.runtime?.pythonVersion;
      beforePackages = before.runtime?.packages;
    }
    materializeFixtures(oraclePaths, manifest.fixtures);
    materializeFixtures(candidatePaths, manifest.fixtures);
    const context = {
      projectRoot,
      ...(workspace === undefined ? {} : { workspace }),
      ...(options.executables === undefined ? {} : { bindings: options.executables }),
      pythonExecutable,
    };
    oracleRun = executeSide("oracle", manifest, oraclePaths, context);
    candidateRun = executeSide("candidate", manifest, candidatePaths, context);
  } catch (error) {
    primaryError = error;
  }
  if (beforeCommit !== undefined && guard !== undefined && manifest.oracleGuard !== undefined) {
    try {
      assertGuardAfter(guard.after(), manifest.oracleGuard);
    } catch (error) {
      afterError = error;
    }
  }
  try {
    if (primaryError !== undefined && afterError !== undefined) {
      throw new HarnessError(
        "RUN_AND_POST_GUARD_FAILED",
        `Scenario failed (${errorMessage(primaryError)}) and post-guard failed (${errorMessage(afterError)})`,
        { cause: primaryError },
      );
    }
    if (primaryError !== undefined) {
      if (primaryError instanceof Error) {
        throw primaryError;
      }
      throw new HarnessError("RUN_FAILED", errorMessage(primaryError));
    }
    if (afterError !== undefined) {
      if (afterError instanceof Error) {
        throw afterError;
      }
      throw new HarnessError("POST_GUARD_FAILED", errorMessage(afterError));
    }
    if (oracleRun === undefined || candidateRun === undefined) {
      throw new HarnessError("RUN_MISSING", "Scenario did not produce both run records");
    }
    const comparison = compareRuns(oracleRun, candidateRun, {
      comparisons: manifest.comparisons,
      normalizations: manifest.normalizations,
      runtimeValues: { oracle: oraclePaths, candidate: candidatePaths },
    });
    const expectations = {
      failures: expectationFailures(manifest, { oracle: oracleRun, candidate: candidateRun }),
    };
    const commands = {
      oracle: {
        executable: manifest.runners.oracle.executable,
        argv: [...manifest.runners.oracle.prefixArgs, ...manifest.argv],
      },
      candidate: {
        executable: manifest.runners.candidate.executable,
        argv: [...manifest.runners.candidate.prefixArgs, ...manifest.argv],
      },
    };
    const base: Omit<EvidenceRecord, "reproducibility"> = {
      schemaVersion: 1,
      scenario: { id: manifest.id, manifestSha256: sha256(canonicalJson(manifest)) },
      commands,
      capturePolicy: manifest.capture,
      expectationPolicy: manifest.expectations,
      normalizationPolicy: manifest.normalizations,
      ...(manifest.scrub === undefined ? {} : { scrubPolicy: manifest.scrub }),
      ...(manifest.stub === undefined ? {} : { stubPolicy: manifest.stub }),
      preconditionPolicy: manifest.preconditions,
      preconditions,
      ...(manifest.oracleGuard === undefined
        ? {}
        : {
            oracleGuard: {
              commit: beforeCommit as string,
              version: manifest.oracleGuard.expectedVersion,
              cleanBefore: true as const,
              cleanAfter: true as const,
              ...(beforePythonVersion === undefined ? {} : { pythonVersion: beforePythonVersion }),
              ...(beforePackages === undefined ? {} : { packages: beforePackages }),
            },
          }),
      runs: { oracle: oracleRun, candidate: candidateRun },
      comparison,
      expectations,
      verdict:
        comparison.verdict === "divergent" || expectations.failures.length > 0
          ? "divergent"
          : "match",
    };
    return { ...base, reproducibility: reproducibility(base) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
