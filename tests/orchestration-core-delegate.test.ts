import { describe, expect, it } from "vitest";

import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const okResult = (overrides: Partial<CollectResult> = {}): CollectResult => ({
  status: "complete",
  output: "done",
  tokensIn: 11,
  tokensOut: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  provider: "fakeprov",
  model: "fake-model-a",
  forcedFallback: false,
  errorKind: null,
  retryAfter: null,
  ...overrides,
});

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";

describe("OrchestrationCore.delegate (contract L5 blocking, L17 batch semantics)", () => {
  it("blocks until every task in the batch settles — the opposite of spawn's non-blocking contract", async () => {
    const barriers = ["a", "b", "c"].map(() => deferred<CollectResult>());
    let started = 0;
    let idCalls = 0;
    const core = new OrchestrationCore({
      // idSource fires synchronously for all three spawns before the gate
      // defers any runChild call — it must not share a counter with
      // runChild's own barrier-selection index.
      runChild: () => {
        const barrier = barriers[started];
        started += 1;
        return barrier?.promise ?? Promise.resolve(okResult());
      },
      idSource: () => {
        const id = `kid-${String(idCalls)}`;
        idCalls += 1;
        return id;
      },
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    let delegateResolved = false;
    const call = core.delegate(["task-a", "task-b", "task-c"]).then((outcomes) => {
      delegateResolved = true;
      return outcomes;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(delegateResolved).toBe(false); // still waiting on all three children

    barriers[0]?.resolve(okResult({ output: "A" }));
    barriers[1]?.resolve(okResult({ output: "B" }));
    barriers[2]?.resolve(okResult({ output: "C" }));

    const outcomes = await call;
    expect(delegateResolved).toBe(true);
    expect(outcomes).toHaveLength(3);
  });

  it("preserves task order in results despite completion arriving shuffled — barrier-forced, never timing (L17)", async () => {
    const barriers = ["a", "b", "c"].map(() => deferred<CollectResult>());
    let started = 0;
    let idCalls = 0;
    const core = new OrchestrationCore({
      runChild: () => {
        const barrier = barriers[started];
        started += 1;
        return barrier?.promise ?? Promise.resolve(okResult());
      },
      idSource: () => {
        const id = `kid-${String(idCalls)}`;
        idCalls += 1;
        return id;
      },
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const call = core.delegate(["task-a", "task-b", "task-c"]);
    await Promise.resolve();
    await Promise.resolve();

    // Deliberately resolve out of task order: C, then A, then B.
    barriers[2]?.resolve(okResult({ output: "C-OUTPUT" }));
    barriers[0]?.resolve(okResult({ output: "A-OUTPUT" }));
    barriers[1]?.resolve(okResult({ output: "B-OUTPUT" }));

    const outcomes = await call;
    // Results come back in TASK order (A, B, C), not completion order (C, A, B).
    expect(outcomes.map((o) => o.summary)).toEqual(["A-OUTPUT", "B-OUTPUT", "C-OUTPUT"]);
  });

  it("isolates a failing task — one error doesn't abort the batch or throw", async () => {
    const core = new OrchestrationCore({
      runChild: (_subId, config) => {
        if (config.prompt === "task-b") {
          return Promise.resolve(
            okResult({
              status: "error",
              output: "Error code: 418 - {'error': {'message': 'T13_DELEGATE_CANARY upstream refused'}}",
              errorKind: null,
            }),
          );
        }
        return Promise.resolve(okResult({ output: `${config.prompt}-OK` }));
      },
      idSource: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `kid-${String(n)}`;
        };
      })(),
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const outcomes = await core.delegate(["task-a", "task-b", "task-c"]);
    expect(outcomes.map((o) => o.status)).toEqual(["complete", "error", "complete"]);
    expect(outcomes[0]?.summary).toBe("task-a-OK");
    expect(outcomes[1]?.summary).toContain("T13_DELEGATE_CANARY");
    expect(outcomes[2]?.summary).toBe("task-c-OK");
  });

  it("renders an empty-output success as the literal '(subagent produced no output)', distinct from an error", async () => {
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult({ output: "" })),
      idSource: () => "kid-1",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const outcomes = await core.delegate(["only-task"]);
    expect(outcomes[0]?.status).toBe("complete");
    expect(outcomes[0]?.summary).toBe("(subagent produced no output)");
  });

  it("passes shared overrides (model/provider/effort/maxIterations) to every spawned task", async () => {
    const receivedPrompts: string[] = [];
    const receivedModels: (string | undefined)[] = [];
    const core = new OrchestrationCore({
      runChild: (_subId, config) => {
        receivedPrompts.push(config.prompt);
        receivedModels.push(config.model);
        return Promise.resolve(okResult());
      },
      idSource: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `kid-${String(n)}`;
        };
      })(),
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    await core.delegate(["task-a", "task-b"], { model: "fake-model-b" });
    expect(receivedPrompts).toEqual(["task-a", "task-b"]);
    expect(receivedModels).toEqual(["fake-model-b", "fake-model-b"]);
  });
});
