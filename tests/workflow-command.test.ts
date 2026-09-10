// Issue #103: `src/commands/workflow.ts` had zero coverage
// (`grep -rln runWorkflowCommand tests` was empty) before this file. Covers
// the single-process behaviors the cross-process suite
// (`tests/workflow-cross-process.test.ts`) does not exercise: the empty and
// not-found messages, `watch`'s "needs a run id" refusal, `--last`, and the
// `limit` clamp (`workflow.ts:83`). No worker, no killed process — plain
// `WorkflowRepository` rows written directly (`requireUnleased: true`, no
// lock/fence machinery needed for a read-only command under test).
//
// Issue #245: `render` shows the pause reason and `watch` prints the
// matching retry hint on stderr when it ends on `paused` — the reason and
// hint constants both live in `src/workflow/service.ts` (durable-run
// surface); this file only asserts the CLI wiring.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runWorkflowCommand } from "../src/commands/workflow.js";
import { openStateDatabase, WorkflowRepository, type StateConnection } from "../src/state/index.js";
import {
  CHECKPOINT_HINT,
  CHECKPOINT_PAUSE,
  QUOTA_PAUSE,
  TOKEN_BUDGET_HINT,
  TOKEN_BUDGET_PAUSE,
  USER_PAUSE,
  USER_PAUSE_HINT,
} from "../src/workflow/service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpDatabase(): StateConnection & { readonly databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "lohra-t103-workflow-command-"));
  roots.push(root);
  const databasePath = join(root, "state.db");
  return { ...openStateDatabase(databasePath), databasePath };
}

function insertRun(
  connection: StateConnection,
  runId: string,
  status: string,
  updatedAt = 0,
  options: { readonly pauseReason?: string | null; readonly tokenBudget?: number | null } = {},
): void {
  new WorkflowRepository(connection.database).putRunState(runId, {
    name: `run-${runId}`,
    owner: null,
    status,
    pauseReason: options.pauseReason ?? null,
    pausePayloadJson: null,
    specJson: null,
    argsJson: null,
    tokenBudget: options.tokenBudget ?? null,
    tainted: false,
    progressJson: null,
    auditSegmentId: null,
    updatedAt,
    fence: null,
    holder: null,
    now: updatedAt,
    requireUnleased: true,
  });
}

// Direct SQL, not `putRunSpend`: that write requires a lease/fence this
// read-only command's tests never take (#245).
function insertSpend(
  connection: StateConnection,
  runId: string,
  tokensIn: number,
  tokensOut: number,
): void {
  connection.database
    .prepare(
      `INSERT INTO workflow_run_spend
       (run_id, token_budget, tokens_in, tokens_out, cache_read_tokens,
        cache_write_tokens, reasoning_tokens, updated_at)
       VALUES (?, NULL, ?, ?, 0, 0, 0, 0)`,
    )
    .run(runId, tokensIn, tokensOut);
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  options: Omit<Parameters<typeof runWorkflowCommand>[0], "stdout" | "stderr">,
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await runWorkflowCommand({
    ...options,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { code, stdout, stderr };
}

describe("runWorkflowCommand (issue #103)", () => {
  it('prints "no workflow runs" for list against an empty database', async () => {
    const connection = tmpDatabase();
    try {
      const result = await run({ action: "list", databasePath: connection.databasePath, args: {} });
      expect(result).toEqual({ code: 0, stdout: "no workflow runs\n", stderr: "" });
    } finally {
      connection.close();
    }
  });

  it("refuses watch with no run id and no --last", async () => {
    const connection = tmpDatabase();
    try {
      const result = await run({
        action: "watch",
        databasePath: connection.databasePath,
        args: {},
      });
      expect(result).toEqual({
        code: 2,
        stdout: "",
        stderr: "watch needs a run id (or --last)\n",
      });
    } finally {
      connection.close();
    }
  });

  it("reports a not-found run id for watch", async () => {
    const connection = tmpDatabase();
    try {
      const result = await run({
        action: "watch",
        databasePath: connection.databasePath,
        args: { run_id: "does-not-exist" },
      });
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: "no workflow run 'does-not-exist'\n",
      });
    } finally {
      connection.close();
    }
  });

  it("--last resolves to the most recently updated run and watch returns once it is terminal", async () => {
    const connection = tmpDatabase();
    try {
      insertRun(connection, "older", "complete", 1);
      insertRun(connection, "newest", "complete", 2);
      const result = await run({
        action: "watch",
        databasePath: connection.databasePath,
        args: { last: true },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("newest".slice(0, 8));
      expect(result.stdout).not.toContain("older");
    } finally {
      connection.close();
    }
  });

  it("clamps a negative limit to 0, hiding every run that otherwise exists", async () => {
    const connection = tmpDatabase();
    try {
      insertRun(connection, "one", "complete", 1);
      insertRun(connection, "two", "complete", 2);
      const result = await run({
        action: "list",
        databasePath: connection.databasePath,
        args: { limit: -5 },
      });
      // Math.min(100, Math.max(0, -5)) === 0 (workflow.ts:83): a limit of 0
      // rows is indistinguishable, at this layer, from no runs at all.
      expect(result).toEqual({ code: 0, stdout: "no workflow runs\n", stderr: "" });
    } finally {
      connection.close();
    }
  });

  it("clamps an oversized limit to 100 without erroring, even with fewer rows than that", async () => {
    const connection = tmpDatabase();
    try {
      insertRun(connection, "one", "complete", 1);
      insertRun(connection, "two", "complete", 2);
      const result = await run({
        action: "list",
        databasePath: connection.databasePath,
        args: { limit: 5_000 },
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim().split("\n")).toHaveLength(2);
    } finally {
      connection.close();
    }
  });

  describe("pause reason and resume hint (#245)", () => {
    it.each([[CHECKPOINT_PAUSE], [TOKEN_BUDGET_PAUSE], [USER_PAUSE], [QUOTA_PAUSE]])(
      "list shows '(%s)' for a run paused with that reason",
      async (pauseReason) => {
        const connection = tmpDatabase();
        try {
          insertRun(connection, "run", "paused", 1, { pauseReason });
          const result = await run({
            action: "list",
            databasePath: connection.databasePath,
            args: {},
          });
          expect(result.code).toBe(0);
          expect(result.stdout).toContain(`paused (${pauseReason})`);
        } finally {
          connection.close();
        }
      },
    );

    it("list does not show a pause suffix for a run that is not paused", async () => {
      const connection = tmpDatabase();
      try {
        // "complete", not "running": a running row with no lock is (stale)
        // (unrelated to #245), which would also match `toContain("(")`.
        insertRun(connection, "run", "complete", 1);
        const result = await run({
          action: "list",
          databasePath: connection.databasePath,
          args: {},
        });
        expect(result.stdout).not.toContain("(");
      } finally {
        connection.close();
      }
    });

    it("list shows '+N over' when spent tokens exceed the token budget", async () => {
      const connection = tmpDatabase();
      try {
        insertRun(connection, "run", "running", 1, { tokenBudget: 1_000 });
        insertSpend(connection, "run", 700, 400);
        const result = await run({
          action: "list",
          databasePath: connection.databasePath,
          args: {},
        });
        expect(result.stdout).toContain("1100/1000 tok (+100 over)");
      } finally {
        connection.close();
      }
    });

    it("list shows no overage suffix when spent tokens are within budget", async () => {
      const connection = tmpDatabase();
      try {
        insertRun(connection, "run", "running", 1, { tokenBudget: 1_000 });
        insertSpend(connection, "run", 300, 200);
        const result = await run({
          action: "list",
          databasePath: connection.databasePath,
          args: {},
        });
        expect(result.stdout).toContain("500/1000 tok");
        expect(result.stdout).not.toContain("over");
      } finally {
        connection.close();
      }
    });

    it("watch prints the checkpoint hint on stderr when it ends paused at a checkpoint", async () => {
      const connection = tmpDatabase();
      try {
        insertRun(connection, "run", "paused", 1, { pauseReason: CHECKPOINT_PAUSE });
        const result = await run({
          action: "watch",
          databasePath: connection.databasePath,
          args: { run_id: "run" },
        });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe(`${CHECKPOINT_HINT}\n`);
      } finally {
        connection.close();
      }
    });

    it("watch prints the token-budget hint on stderr when it ends paused for budget", async () => {
      const connection = tmpDatabase();
      try {
        insertRun(connection, "run", "paused", 1, { pauseReason: TOKEN_BUDGET_PAUSE });
        const result = await run({
          action: "watch",
          databasePath: connection.databasePath,
          args: { run_id: "run" },
        });
        expect(result.stderr).toBe(`${TOKEN_BUDGET_HINT}\n`);
      } finally {
        connection.close();
      }
    });

    it("watch prints the user-pause hint on stderr when it ends paused by request", async () => {
      const connection = tmpDatabase();
      try {
        insertRun(connection, "run", "paused", 1, { pauseReason: USER_PAUSE });
        const result = await run({
          action: "watch",
          databasePath: connection.databasePath,
          args: { run_id: "run" },
        });
        expect(result.stderr).toBe(`${USER_PAUSE_HINT}\n`);
      } finally {
        connection.close();
      }
    });

    it("watch prints nothing on stderr when it ends paused for quota (auto-resume, no hint)", async () => {
      const connection = tmpDatabase();
      try {
        insertRun(connection, "run", "paused", 1, { pauseReason: QUOTA_PAUSE });
        const result = await run({
          action: "watch",
          databasePath: connection.databasePath,
          args: { run_id: "run" },
        });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
      } finally {
        connection.close();
      }
    });
  });
});
