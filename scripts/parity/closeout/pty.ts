import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ApprovalManager, terminalTool } from "../../../src/tools/index.js";

const project = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(project, ".parity-evidence", "t22");
const root = mkdtempSync(join(tmpdir(), "lohra-t22-pty-"));

function captures(): readonly string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("lohra-terminal-"));
}

try {
  const before = new Set(captures());
  const result = JSON.parse(
    await terminalTool(
      {
        command: "printf 'native-out'; printf 'native-err' >&2; pwd; exit 7",
        cwd: root,
      },
      { approvalManager: new ApprovalManager() },
    ),
  ) as {
    readonly ok?: boolean;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exit_code?: number;
  };
  if (result.ok !== true) throw new Error("PTY_RESULT_NOT_OK");
  if (result.stdout !== `native-out${root}\n`) throw new Error("PTY_STDOUT");
  if (result.stderr !== "native-err") throw new Error("PTY_STDERR");
  if (result.exit_code !== 7) throw new Error("PTY_EXIT");

  const timeout = JSON.parse(
    await terminalTool(
      { command: "sleep 2", timeout: 0 },
      { approvalManager: new ApprovalManager() },
    ),
  ) as { readonly error?: string };
  if (timeout.error !== "command timed out after 0s") throw new Error("PTY_TIMEOUT");

  const after = captures().filter((name) => !before.has(name));
  if (after.length !== 0) throw new Error(`PTY_CAPTURE_LEAK:${after.join(",")}`);

  const packageMetadata = JSON.parse(
    readFileSync(join(project, "node_modules", "node-pty", "package.json"), "utf8"),
  ) as { readonly name?: string; readonly version?: string };
  if (packageMetadata.name !== "node-pty" || packageMetadata.version !== "1.1.0") {
    throw new Error("PTY_PACKAGE");
  }
  const helper = join(
    project,
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper",
  );
  const helperExecutable = process.platform !== "darwin" || (statSync(helper).mode & 0o111) !== 0;
  if (!helperExecutable) throw new Error("PTY_HELPER_NOT_EXECUTABLE");

  const observation = {
    package: "node-pty@1.1.0",
    native: true,
    cwd: true,
    stdout: true,
    stderr: true,
    exitCode: 7,
    timeout: true,
    captureCleanup: true,
    helperExecutable,
    platform: process.platform,
    networkUsed: false,
    credentialsUsed: false,
  };
  const canonical = `${JSON.stringify(observation)}\n`;
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, "pty.json"), canonical);
  process.stdout.write(
    `${JSON.stringify({ ...observation, digest: createHash("sha256").update(canonical).digest("hex") })}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
