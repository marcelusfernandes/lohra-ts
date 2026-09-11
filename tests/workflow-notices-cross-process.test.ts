// Issue #402 (M8-6): cross-process proof for `lohra workflow notices` —
// same posture as `tests/workflow-cross-process.test.ts:17,265` (spawn
// real, `tsx`, imports from `src/` never `dist/`, no build step needed),
// but every step here is synchronous (`spawnSync`): unlike that file's
// process A (which stays alive with a leaf "in flight" until SIGKILLed),
// none of these three processes needs to survive past its own exit.
//
// Process A never goes through the CLI (there is no `lohra workflow
// notices --write`, by design — issue #402's own "fora de escopo") — it
// writes ONE durable notice directly through `NoticesRepository`, under a
// REAL fence (`LockRepository.acquireRunLease`), exactly the ownership
// check `NoticesRepository.append` enforces for a `run:<id>` scope
// (`src/state/notices-repository.ts`). Its source is generated into the
// test's own tmp root at runtime (never a tracked file under
// `tests/workers/`) and run the same way `tests/cli-serve-process.test.ts`
// runs `src/cli.ts` itself: `node --import tsx <script>`.
//
// Process B and C ARE the CLI (`lohra workflow notices RUN --json`,
// `--ack`, `--all`) — the actual surface this issue adds.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");
const cliEntry = resolve(repoRoot, "src/cli.ts");

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function srcUrl(relative: string): string {
  return pathToFileURL(resolve(srcRoot, relative)).href;
}

/** Process A: writes exactly one durable notice under a real fence, for the
 * given `runId`, then exits. Generated at runtime — see file header. */
function writeWorkerSource(): string {
  return [
    `import { openStateDatabase } from ${JSON.stringify(srcUrl("state/connection.js"))};`,
    `import { LockRepository } from ${JSON.stringify(srcUrl("state/locks.js"))};`,
    `import { NoticesRepository } from ${JSON.stringify(srcUrl("state/notices-repository.js"))};`,
    "",
    "const [databasePath, runId, nowArg] = process.argv.slice(2);",
    "const now = Number(nowArg);",
    "const connection = openStateDatabase(databasePath);",
    "const locks = new LockRepository(connection.database);",
    'const fence = locks.acquireRunLease(runId, "worker-a", now, 900);',
    "if (fence === null) {",
    '  console.error("LEASE_FAILED");',
    "  process.exit(1);",
    "}",
    "const notices = new NoticesRepository(connection.database);",
    "const written = notices.append(",
    "  `run:${runId}`,",
    '  { kind: "queue_overflow", message: "cross-process notice from worker A" },',
    '  { fence, holder: "worker-a", now },',
    ");",
    "if (written === null) {",
    '  console.error("APPEND_REFUSED");',
    "  process.exit(1);",
    "}",
    "console.log(`WROTE ${written.id}`);",
    "connection.close();",
    "",
  ].join("\n");
}

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-t402-cross-process-"));
  roots.push(root);
  return root;
}

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCliOnce(home: string, args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: repoRoot,
    env: {
      HOME: home,
      LOHRA_HOME: home,
      PATH: "/usr/bin:/bin",
      NO_COLOR: "1",
      TZ: "UTC",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("cross-process: lohra workflow notices sees a notice a different process wrote under fence (issue #402)", () => {
  it("process A writes under fence, process B lists+acks over --json, process C sees it gone, --all still shows acked_at", () => {
    const root = tmpRoot();
    const home = join(root, "home");
    const databasePath = join(home, "state.db");
    const runId = "t402-cross-process-run";
    const now = 1_000;

    // --- process A: write ONE notice under a real fence ---
    const workerPath = join(root, "write-worker.mjs");
    writeFileSync(workerPath, writeWorkerSource(), "utf8");
    const written = spawnSync(
      process.execPath,
      ["--import", "tsx", workerPath, databasePath, runId, String(now)],
      { cwd: repoRoot, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 15_000 },
    );
    expect(written.error, written.stderr).toBeUndefined();
    expect(written.status, written.stderr).toBe(0);
    const noticeId = /WROTE (\d+)/.exec(written.stdout)?.[1];
    expect(noticeId, written.stdout).toBeTypeOf("string");
    if (noticeId === undefined) throw new Error("unreachable: asserted above");

    // --- process B: lists it, then acks it, both via the real CLI ---
    const listedByB = runCliOnce(home, ["workflow", "notices", runId, "--json"]);
    expect(listedByB.status, listedByB.stderr).toBe(0);
    const pageB = JSON.parse(listedByB.stdout) as {
      readonly notices: readonly { readonly id: number; readonly acked_at: number | null }[];
    };
    expect(pageB.notices.map((notice) => String(notice.id))).toContain(noticeId);
    const beforeAck = pageB.notices.find((notice) => String(notice.id) === noticeId);
    expect(beforeAck?.acked_at).toBeNull();

    const ackedByB = runCliOnce(home, ["workflow", "notices", "--ack", noticeId, "--json"]);
    expect(ackedByB.status, ackedByB.stderr).toBe(0);
    const ackPage = JSON.parse(ackedByB.stdout) as { readonly acked: boolean };
    expect(ackPage.acked).toBe(true);

    // --- process C: a THIRD process, its own invocation of the CLI —
    // the acked notice is gone from the default (unacked-only) listing ---
    const listedByC = runCliOnce(home, ["workflow", "notices", runId, "--json"]);
    expect(listedByC.status, listedByC.stderr).toBe(0);
    const pageC = JSON.parse(listedByC.stdout) as {
      readonly notices: readonly { readonly id: number }[];
    };
    expect(pageC.notices.map((notice) => String(notice.id))).not.toContain(noticeId);

    // --all still shows it, now with acked_at set — never silently dropped.
    const allByC = runCliOnce(home, ["workflow", "notices", runId, "--all", "--json"]);
    expect(allByC.status, allByC.stderr).toBe(0);
    const pageAll = JSON.parse(allByC.stdout) as {
      readonly notices: readonly { readonly id: number; readonly acked_at: number | null }[];
    };
    const afterAck = pageAll.notices.find((notice) => String(notice.id) === noticeId);
    expect(afterAck?.acked_at).not.toBeNull();
  }, 30_000);
});
