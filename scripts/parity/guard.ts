import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";

import { HarnessError } from "./errors.js";
import { runTypeScriptProcess } from "./process.js";
import type { OracleWorkspace } from "./resolve.js";
import type { OracleGuardSpec } from "./types.js";

export interface GuardSnapshot {
  readonly commit: string;
  readonly porcelain: string;
  readonly version?: {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  };
}

export interface GuardProvider {
  before(): GuardSnapshot;
  after(): GuardSnapshot;
}

function decode(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

export function assertGuardBefore(snapshot: GuardSnapshot, expected: OracleGuardSpec): void {
  if (snapshot.commit !== expected.expectedCommit) {
    throw new HarnessError(
      "ORACLE_COMMIT_MISMATCH",
      `Oracle commit mismatch: expected ${expected.expectedCommit}, received ${snapshot.commit}`,
    );
  }
  if (snapshot.porcelain !== "") {
    throw new HarnessError("ORACLE_DIRTY", "Oracle checkout is not porcelain-clean");
  }
  if (snapshot.version === undefined) {
    throw new HarnessError("ORACLE_VERSION_MISSING", "Oracle version probe is missing");
  }
  if (
    snapshot.version.exitCode !== 0 ||
    snapshot.version.stdout !== expected.expectedVersion ||
    snapshot.version.stderr !== ""
  ) {
    throw new HarnessError(
      "ORACLE_VERSION_MISMATCH",
      `Oracle version mismatch: expected ${JSON.stringify(expected.expectedVersion)}, received exit=${String(snapshot.version.exitCode)} stdout=${JSON.stringify(snapshot.version.stdout)} stderr=${JSON.stringify(snapshot.version.stderr)}`,
    );
  }
}

export function assertGuardAfter(snapshot: GuardSnapshot, expected: OracleGuardSpec): void {
  if (snapshot.commit !== expected.expectedCommit) {
    throw new HarnessError(
      "ORACLE_COMMIT_CHANGED",
      `Oracle commit changed after execution: expected ${expected.expectedCommit}, received ${snapshot.commit}`,
    );
  }
  if (snapshot.porcelain !== "") {
    throw new HarnessError("ORACLE_DIRTY_AFTER", "Oracle checkout became dirty after execution");
  }
}

export function createGuardProvider(
  workspace: OracleWorkspace,
  limits: { readonly timeoutMs: number; readonly maxOutputBytes: number },
): GuardProvider {
  const git = process.env.LOHRA_PARITY_GIT ?? "/usr/bin/git";
  if (!isAbsolute(git) || !existsSync(git)) {
    throw new HarnessError(
      "GIT_NOT_FOUND",
      "Git guard executable must be an existing absolute path",
    );
  }
  const runGit = (args: readonly string[]): string => {
    const result = runTypeScriptProcess({
      executable: git,
      argv: ["-C", workspace.repository, ...args],
      cwd: workspace.repository,
      environment: { PATH: "/usr/bin:/bin" },
      ...limits,
    });
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new HarnessError(
        "ORACLE_GIT",
        `Oracle git guard failed: ${decode(result.stderr).trim()}`,
      );
    }
    return decode(result.stdout);
  };
  const repositorySnapshot = (): GuardSnapshot => ({
    commit: runGit(["rev-parse", "HEAD"]).trim(),
    porcelain: runGit(["status", "--porcelain"]),
  });
  return {
    before(): GuardSnapshot {
      const repository = repositorySnapshot();
      const guardRoot = mkdtempSync(join(tmpdir(), "lohra-parity-guard-"));
      try {
        const version = runTypeScriptProcess({
          executable: workspace.executable,
          argv: ["--version"],
          cwd: guardRoot,
          environment: { HOME: guardRoot, PATH: "/usr/bin:/bin", PYTHONUTF8: "1" },
          ...limits,
        });
        return {
          ...repository,
          version: {
            exitCode: version.exitCode,
            stdout: decode(version.stdout),
            stderr: decode(version.stderr),
          },
        };
      } finally {
        rmSync(guardRoot, { recursive: true, force: true });
      }
    },
    after: repositorySnapshot,
  };
}
