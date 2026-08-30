import { describe, expect, it } from "vitest";

import { OrchestrationCore, type CollectResult, type SpawnConfig } from "../src/orchestration/core.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
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

describe("OrchestrationCore.steer — busy/queued form (contract decision 6 / L6)", () => {
  it("returns null for an unknown sub_id", () => {
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult()),
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    expect(core.steer("deadbeef", "hi")).toBeNull();
  });

  it("enqueues into the child's inbox while running, returning queued:true, drained as one merged <system-reminder> message", async () => {
    const barrier = deferred<CollectResult>();
    const drainCalls: (readonly Readonly<Record<string, unknown>>[])[] = [];
    const core = new OrchestrationCore({
      runChild: (_subId, _config, _systemPrompt, drainMessages) => {
        drainCalls.push(drainMessages());
        return barrier.promise;
      },
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const { subId } = core.spawn({ prompt: "task" });
    await flushMicrotasks(); // let runChild start, draining once with nothing pending

    const first = core.steer(subId, "STEER-ALPHA");
    const second = core.steer(subId, "STEER-BRAVO");
    expect(first).toEqual({ queued: true });
    expect(second).toEqual({ queued: true });

    // The two pending texts merge into ONE <system-reminder> message when
    // the runner's own iteration loop drains the inbox again.
    expect(core.drainInboxFor(subId)).toEqual([
      {
        role: "user",
        content: "<system-reminder>\nSTEER-ALPHA\nSTEER-BRAVO\n</system-reminder>",
      },
    ]);
    // Draining clears it — a subsequent drain with nothing new pending is empty.
    expect(core.drainInboxFor(subId)).toEqual([]);

    barrier.resolve(okResult());
  });

  it("queued-in-pool: a spawned-but-not-yet-started child also returns queued:true (L6)", () => {
    const barrier = deferred<CollectResult>();
    const core = new OrchestrationCore({
      runChild: () => barrier.promise,
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 1,
      buildSubagentPrompt: stubPrompt,
    });

    core.spawn({ prompt: "occupies the slot" }); // saturates the single slot
    const queued = core.spawn({ prompt: "never actually started yet" });

    // The second child hasn't started its first upstream call at all (the
    // gate hasn't admitted it), yet steer must still queue, not resurrect.
    expect(core.steer(queued.subId, "STEER-EARLY")).toEqual({ queued: true });

    barrier.resolve(okResult());
  });
});

describe("OrchestrationCore.steer — idle/terminal form (contract decision 6 / L6, L7)", () => {
  it("resurrects a terminal child with the raw text as a new turn's input, returning queued:false", async () => {
    let call = 0;
    const receivedConfigs: SpawnConfig[] = [];
    const core = new OrchestrationCore({
      runChild: (_subId, config) => {
        receivedConfigs.push(config);
        call += 1;
        return Promise.resolve(
          call === 1 ? okResult({ output: "KID-FIRST-OUTPUT" }) : okResult({ output: "KID-SECOND-OUTPUT" }),
        );
      },
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const { subId } = core.spawn({ prompt: "first task", model: "fake-model-b" });
    const firstOutcome = await core.collect(subId, true);
    expect(firstOutcome.kind).toBe("settled");

    const steerResult = core.steer(subId, "SECOND-TURN-TEXT");
    expect(steerResult).toEqual({ queued: false });

    // The resurrection call reuses the original spawn overrides, swapping
    // only the prompt for the raw steer text — steer_session has no
    // override arguments of its own.
    await flushMicrotasks();
    expect(receivedConfigs[1]).toEqual({ prompt: "SECOND-TURN-TEXT", model: "fake-model-b" });

    const secondOutcome = await core.collect(subId, true);
    expect(secondOutcome.kind).toBe("settled");
    if (secondOutcome.kind === "settled") {
      expect(secondOutcome.result.output).toBe("KID-SECOND-OUTPUT");
    }
  });

  it("L7: collect(wait:false) during the resurrected turn keeps returning the STALE first-turn result — status lies, on purpose, reproduced not fixed", async () => {
    const secondTurn = deferred<CollectResult>();
    let call = 0;
    const core = new OrchestrationCore({
      runChild: () => {
        call += 1;
        return call === 1 ? Promise.resolve(okResult({ output: "KID-FIRST-OUTPUT" })) : secondTurn.promise;
      },
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const { subId } = core.spawn({ prompt: "first task" });
    const firstResult = await core.collect(subId, true);
    expect(firstResult.kind).toBe("settled");

    core.steer(subId, "SECOND-TURN-TEXT"); // resurrects — second turn now in flight

    // Polling mid-flight returns the OLD result, ok:true, exactly as L7
    // measured — this is the oracle's own bug, reproduced deliberately.
    const midFlight = await core.collect(subId, false);
    expect(midFlight.kind).toBe("settled");
    if (midFlight.kind === "settled") {
      expect(midFlight.result.output).toBe("KID-FIRST-OUTPUT");
    }

    // wait:true, in contrast, blocks for the CURRENT (second) turn, not the
    // stale cached one.
    let resolved = false;
    const waiting = core.collect(subId, true).then((outcome) => {
      resolved = true;
      return outcome;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false); // still genuinely waiting on the live turn

    secondTurn.resolve(okResult({ output: "KID-SECOND-OUTPUT", tokensIn: 22, tokensOut: 14 }));
    const finalOutcome = await waiting;
    expect(finalOutcome.kind).toBe("settled");
    if (finalOutcome.kind === "settled") {
      expect(finalOutcome.result.output).toBe("KID-SECOND-OUTPUT");
    }

    // And the poll-based view catches up once the second turn actually lands.
    const afterSettle = await core.collect(subId, false);
    expect(afterSettle.kind).toBe("settled");
    if (afterSettle.kind === "settled") {
      expect(afterSettle.result.output).toBe("KID-SECOND-OUTPUT");
    }
  });

  it("steering again while a resurrected turn is still in flight queues into the inbox, not a redundant third turn — stale result must not be misread as idle", async () => {
    const secondTurn = deferred<CollectResult>();
    let startedTurns = 0;
    const core = new OrchestrationCore({
      runChild: (_subId, _config, _systemPrompt, drainMessages) => {
        startedTurns += 1;
        if (startedTurns === 1) return Promise.resolve(okResult({ output: "KID-FIRST-OUTPUT" }));
        // Second turn: read whatever's in the inbox once, to prove the
        // second steer landed there instead of starting its own turn.
        void drainMessages();
        return secondTurn.promise;
      },
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const { subId } = core.spawn({ prompt: "first task" });
    await core.collect(subId, true); // first turn settles — now idle/terminal

    expect(core.steer(subId, "RESURRECT")).toEqual({ queued: false }); // starts the second turn
    await flushMicrotasks(); // let the gate admit the resurrection's runChild call
    expect(startedTurns).toBe(2);

    // A second steer call arrives WHILE the resurrection is still in
    // flight. entry.result is still the stale first-turn value at this
    // point — the bug this test guards against is treating that staleness
    // as "idle" and starting a THIRD turn instead of queuing.
    expect(core.steer(subId, "QUEUED-DURING-RESURRECTION")).toEqual({ queued: true });

    secondTurn.resolve(okResult({ output: "KID-SECOND-OUTPUT" }));
    await core.collect(subId, true);

    // Only two turns ever started — the second steer queued, it didn't spawn a third.
    expect(startedTurns).toBe(2);
  });
});
