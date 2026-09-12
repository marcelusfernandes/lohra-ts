// Issue #425 (M10-S4): `workflow_leaf_read {run_id, sub_id, max_chars?}` — real
// sqlite, no network, same posture as `tests/workflow-notices-tool.test.ts`
// (#402): a real durable store, the handler dispatched directly, built off
// `createSessionToolBase` (`src/commands/session-tools.ts`) for the
// `AuditRepository` this tool shares with `workflow_audit`.
//
// Round 2 (revisor #432): the first pass proved the CLAMP behaviour was
// correct by hand (999999 -> 32768, ""/0 -> 4096, "abc" -> error, -5 -> 1)
// but only ever exercised `max_chars: 12` in the suite — three mutants that
// removed the clamp/""/0-default branches still passed. This file now
// covers every branch of `parseMaxChars` directly, plus the two behaviour
// fixes from the same round: no false `truncated` for an already-empty
// turn, and the named `MAX_TURNS` cap with `truncated_turns`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSessionToolBase } from "../src/commands/session-tools.js";
import { openStateDatabase, type StateConnection } from "../src/state/connection.js";
import { SessionRepository } from "../src/state/index.js";
import { CHILD_EXCLUDED_TOOLS, createChildDispatch } from "../src/tools/child.js";
import { workflowLeafReadHandler } from "../src/workflow/leaf-read-tool.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

interface Harness {
  readonly connection: StateConnection;
  readonly base: ReturnType<typeof createSessionToolBase>;
  readonly sessions: SessionRepository;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "lohra-leaf-read-tool-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const base = createSessionToolBase(connection.database, {});
  const sessions = new SessionRepository(connection.database);
  return { connection, base, sessions };
}

function handlerFor(target: Harness) {
  return workflowLeafReadHandler(target.connection.database, target.base.auditRepository);
}

/** Mirrors what `child-repository.ts` stamps on every leaf session, and what
 * `audit-runtime.ts:211-228` writes at spawn, without spinning up the whole
 * orchestration engine. */
function plantLeaf(
  target: Harness,
  input: { readonly subId: string; readonly parentId: string; readonly runId: string },
): void {
  target.sessions.createSession({
    id: input.subId,
    source: "orchestration",
    parentSessionId: input.parentId,
  });
  target.base.auditRepository.append(input.runId, {
    event_type: "leaf.started",
    sub_id: input.subId,
    node_id: "worker",
  });
}

interface LeafReadEnvelope {
  readonly ok?: boolean;
  readonly error?: string;
  readonly sub_id?: string;
  readonly run_id?: string;
  readonly truncated?: boolean;
  readonly truncated_turns?: boolean;
  readonly note?: string;
  readonly turns?: readonly {
    readonly role: string;
    readonly content: string | null;
    readonly created_at: number;
  }[];
}

describe("workflow_leaf_read tool (#425)", () => {
  it("reads the turns already committed by a live leaf", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-1", parentId: "parent-1", runId: "run-1" });
    target.sessions.recordTurn("leaf-1", {
      user: { role: "user", content: "how's the migration going?" },
      assistant: { role: "assistant", content: "half the rows are done" },
    });

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-1", sub_id: "leaf-1" }),
    ) as LeafReadEnvelope;

    expect(parsed.ok, "MUTATION_CAUSE:M425-leaf-read-ok").toBe(true);
    expect(parsed.sub_id).toBe("leaf-1");
    expect(parsed.run_id).toBe("run-1");
    expect(parsed.truncated).toBe(false);
    expect(parsed.truncated_turns).toBe(false);
    expect(parsed.note).toContain("turnos assentados");
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns?.[0]).toMatchObject({
      role: "user",
      content: "how's the migration going?",
    });
    expect(parsed.turns?.[1]).toMatchObject({
      role: "assistant",
      content: "half the rows are done",
    });
    expect(typeof parsed.turns?.[0]?.created_at).toBe("number");
  });

  it("truncates content to max_chars and reports truncated:true", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-2", parentId: "parent-1", runId: "run-2" });
    target.sessions.recordTurn("leaf-2", {
      user: { role: "user", content: "0123456789" },
      assistant: { role: "assistant", content: "abcdefghij" },
    });

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-2", sub_id: "leaf-2", max_chars: 12 }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    const combined = (parsed.turns ?? []).map((turn) => turn.content ?? "").join("");
    expect(combined).toHaveLength(12);
    // #435: the budget is spent from the MOST RECENT turn backward, so the
    // assistant reply (the more recent of the two) is the one kept whole;
    // the user turn (older) absorbs the cut. Before #435 this was
    // "0123456789ab" (oldest-first spend).
    expect(combined).toBe("01abcdefghij");
  });

  it("clamps an oversized max_chars to 32768 (kills the removed-clamp mutant)", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-clamp-high", parentId: "parent-1", runId: "run-clamp-high" });
    target.sessions.recordTurn("leaf-clamp-high", {
      user: { role: "user", content: "u".repeat(20000) },
      assistant: { role: "assistant", content: "a".repeat(20000) },
    });

    const parsed = JSON.parse(
      await handlerFor(target)({
        run_id: "run-clamp-high",
        sub_id: "leaf-clamp-high",
        max_chars: 999999,
      }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    const combined = (parsed.turns ?? []).map((turn) => turn.content ?? "").join("");
    expect(combined).toHaveLength(32768);
  });

  it.each([["", "empty string"] as const, [0, "zero"] as const])(
    "treats max_chars %j (%s) as the 4096 default (kills the removed-default mutant)",
    async (maxChars, _label) => {
      const target = harness();
      const subId = `leaf-default-${String(maxChars)}`;
      plantLeaf(target, { subId, parentId: "parent-1", runId: `run-default-${String(maxChars)}` });
      target.sessions.recordTurn(subId, {
        user: { role: "user", content: "u".repeat(3000) },
        assistant: { role: "assistant", content: "a".repeat(3000) },
      });

      const parsed = JSON.parse(
        await handlerFor(target)({
          run_id: `run-default-${String(maxChars)}`,
          sub_id: subId,
          max_chars: maxChars,
        }),
      ) as LeafReadEnvelope;

      expect(parsed.ok).toBe(true);
      expect(parsed.truncated).toBe(true);
      const combined = (parsed.turns ?? []).map((turn) => turn.content ?? "").join("");
      expect(combined).toHaveLength(4096);
    },
  );

  it("names the error for a non-integer max_chars instead of silently defaulting", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-bad-max-chars", parentId: "parent-1", runId: "run-bad" });
    target.sessions.recordTurn("leaf-bad-max-chars", {
      user: { role: "user", content: "hi" },
      assistant: { role: "assistant", content: "hi back" },
    });

    const parsed = JSON.parse(
      await handlerFor(target)({
        run_id: "run-bad",
        sub_id: "leaf-bad-max-chars",
        max_chars: "abc",
      }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBeUndefined();
    expect(parsed.error).toContain("max_chars must be an integer");
  });

  it("clamps a negative max_chars up to 1 (kills a removed-lower-clamp mutant)", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-clamp-low", parentId: "parent-1", runId: "run-clamp-low" });
    target.sessions.recordTurn("leaf-clamp-low", {
      user: { role: "user", content: "hello" },
      assistant: { role: "assistant", content: "world" },
    });

    const parsed = JSON.parse(
      await handlerFor(target)({
        run_id: "run-clamp-low",
        sub_id: "leaf-clamp-low",
        max_chars: -5,
      }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    const combined = (parsed.turns ?? []).map((turn) => turn.content ?? "").join("");
    // #435: budget of 1 char is spent on the MOST RECENT turn (the
    // assistant reply "world") first; the older user turn ("hello") gets
    // nothing. Before #435 this was "h" (oldest-first spend).
    expect(combined).toBe("w");
  });

  it("spends the max_chars budget from the MOST RECENT turn backward, not the oldest (#435)", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-recent", parentId: "parent-1", runId: "run-recent" });
    // 60 turns x 2 rows (user+assistant) = 120 rows of 100 chars each,
    // 12000 chars total — well OVER the default 4096-char budget, so the
    // budget genuinely runs out partway through. Oldest-first spend (the
    // pre-#435 bug) fills the FIRST ~40 rows and leaves `turns.at(-1)`
    // empty — exactly the failure the issue measured. Most-recent-first
    // spend must fill the LAST ~40 rows instead, so the tail of the
    // conversation is never empty.
    for (let index = 0; index < 60; index += 1) {
      target.sessions.recordTurn("leaf-recent", {
        user: { role: "user", content: `u${String(index)}`.padEnd(100, "0") },
        assistant: { role: "assistant", content: `a${String(index)}`.padEnd(100, "0") },
      });
    }

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-recent", sub_id: "leaf-recent" }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncated_turns).toBe(false);
    expect(parsed.turns).toHaveLength(120);
    // The most recent turn (the very last one written) must come back
    // whole. On the base implementation this is "" — red by assertion.
    expect(parsed.turns?.at(-1)).toMatchObject({
      role: "assistant",
      content: "a59".padEnd(100, "0"),
    });
    // The oldest turn is entirely emptied by the budget running out first.
    expect(parsed.turns?.[0]).toMatchObject({ role: "user", content: "" });
    // The boundary row (row 79 of 120, 0-indexed: assistant turn 39) is the
    // one actually sliced mid-content — 96 of its 100 chars survive,
    // pinning WHERE the cut falls, not just that the tail is whole.
    expect(parsed.turns?.[79]?.content).toHaveLength(96);
    expect(parsed.turns?.[79]?.content).toBe("a39".padEnd(100, "0").slice(0, 96));
  });

  it("does not report truncated:true for a turn that was already empty", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-empty-tail", parentId: "parent-1", runId: "run-empty-tail" });
    // #435 round 2 (revisor): the empty turn must be among the OLDEST rows,
    // because the budget is now spent MOST-RECENT-FIRST (rowsDesc). The
    // user turn here is legitimately empty (e.g. a tool-calling turn with
    // no prose) and is the OLDER of the two, so it is visited SECOND in
    // rowsDesc order, by which point the assistant turn (the more recent
    // one) has already exhausted the whole budget (10 chars exactly —
    // nothing is actually cut anywhere). This is what makes the guard
    // order in `truncateTurns` (the `content.length === 0` check BEFORE
    // `budget <= 0`, #432 round 2) load-bearing again: swap the two `if`s
    // and this empty, already-exhausted-budget turn wrongly flips
    // `truncated` to true.
    target.sessions.recordTurn("leaf-empty-tail", {
      user: { role: "user", content: "" },
      assistant: { role: "assistant", content: "0123456789" },
    });

    const parsed = JSON.parse(
      await handlerFor(target)({
        run_id: "run-empty-tail",
        sub_id: "leaf-empty-tail",
        max_chars: 10,
      }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(false);
    expect(parsed.turns?.[0]?.content).toBe("");
    expect(parsed.turns?.[1]?.content).toBe("0123456789");
  });

  it("names the error for a sub_id that belongs to a different run", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-3", parentId: "parent-1", runId: "run-3" });

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-other", sub_id: "leaf-3" }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBeUndefined();
    expect(parsed.error).toBeTruthy();
    expect(parsed.error).toContain("leaf-3");
  });

  it("names the error for a sub_id that is not an orchestration leaf", async () => {
    const target = harness();
    target.sessions.createSession({ id: "cli-session", source: "cli" });

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-4", sub_id: "cli-session" }),
    ) as LeafReadEnvelope;

    expect(parsed.error).toBeTruthy();
  });

  it("names the error for an unknown sub_id", async () => {
    const target = harness();
    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-5", sub_id: "ghost" }),
    ) as LeafReadEnvelope;
    expect(parsed.error).toBeTruthy();
  });

  it("caps the turns returned at MAX_TURNS (200), keeping the MOST RECENT ones", async () => {
    const target = harness();
    plantLeaf(target, { subId: "leaf-many", parentId: "parent-1", runId: "run-many" });
    // 110 turns x 2 rows (user+assistant) = 220 rows, over the 200-row cap —
    // this is an addition beyond the issue's original AC (invariant 3: no
    // unbounded read of a live leaf's history), called out in the PR body.
    for (let i = 0; i < 110; i += 1) {
      target.sessions.recordTurn("leaf-many", {
        user: { role: "user", content: `user-${String(i)}` },
        assistant: { role: "assistant", content: `assistant-${String(i)}` },
      });
    }

    const parsed = JSON.parse(
      await handlerFor(target)({ run_id: "run-many", sub_id: "leaf-many", max_chars: 32768 }),
    ) as LeafReadEnvelope;

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated_turns).toBe(true);
    expect(parsed.turns).toHaveLength(200);
    // The oldest 10 turns (i = 0..9, 20 rows) were dropped; the 200 kept
    // start at i = 10 and end at the very last one written, i = 109.
    expect(parsed.turns?.[0]).toMatchObject({ role: "user", content: "user-10" });
    expect(parsed.turns?.at(-1)).toMatchObject({ role: "assistant", content: "assistant-109" });
  });

  it("is excluded from subagents (CHILD_EXCLUDED_TOOLS + createChildDispatch)", async () => {
    expect(CHILD_EXCLUDED_TOOLS).toContain("workflow_leaf_read");
    const dispatch = createChildDispatch(() => Promise.resolve("{}"));
    const result = JSON.parse(await dispatch("workflow_leaf_read", {})) as { error?: string };
    expect(result.error).toContain("workflow_leaf_read");
    expect(result.error).toContain("not available to subagents");
  });
});
