// Issue #520 (M16-S5, épico #490, ADR 0005): `core.steer` on a busy leaf
// only ever pushed to the inbox (`core.ts:322-329` on main 167c2669) — a
// call already in flight ran to completion untouched, so a steer's latency
// was bounded by the stream's own duration. D2 (adopted by default): EVERY
// steer on a busy leaf interrupts a call ACTUALLY in flight; a leaf busy
// but between calls (executing a tool) is unaffected — the inbox alone.
//
// RED on main 167c2669: `entry.interrupt` doesn't exist, `runAndTrack` never
// passes a 6th `interrupts` argument to `runChild`, and `core.steer`'s
// return type has no `interrupted` key — the assertions below fail on a
// TypeScript error (the key doesn't typecheck) before ever running, which
// is exactly the "vermelho na base (chave inexistente)" the issue's own AC
// names.
import { describe, expect, it } from "vitest";

import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
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
  errorKind: null,
  retryAfter: null,
  ...overrides,
});

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";

/** `ChildRunner`'s 6th (optional) parameter — annotated explicitly here so
 * these fakes stay soundly typed (never implicit `any`) whether or not the
 * base `ChildRunner` type itself already declares it. */
type Interrupts = { readonly arm: (abort: () => void) => () => void };

describe("OrchestrationCore.steer — interrupt hook (issue #520, D2)", () => {
  it("a busy leaf with a call genuinely in flight: steer arms the hook, calls it exactly once, and reports interrupted:true", async () => {
    const barrier = deferred<CollectResult>();
    let abortCalls = 0;
    const core = new OrchestrationCore({
      runChild: (
        _subId,
        _config,
        _systemPrompt,
        _drainMessages,
        _signal,
        interrupts?: Interrupts,
      ) => {
        // Mirrors what ConversationRuntime.runTurn actually does: arm the
        // hook right before the (fake) provider call, never disarm it
        // while that call is still "in flight" (the test never resolves
        // `barrier` before steering).
        interrupts?.arm(() => {
          abortCalls += 1;
        });
        return barrier.promise;
      },
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const { subId } = core.spawn({ prompt: "task" });
    await flushMicrotasks(); // let runChild start and arm the hook

    const outcome = core.steer(subId, "STEER-TEXT");
    expect(outcome).toEqual({ queued: true, interrupted: true });
    expect(abortCalls).toBe(1);

    // The text still landed in the inbox (D2 never replaces L6, it adds to
    // it) — drained the same way an un-interrupted busy steer would be.
    expect(core.drainInboxFor(subId)).toEqual([
      { role: "user", content: "<system-reminder>\nSTEER-TEXT\n</system-reminder>" },
    ]);

    barrier.resolve(okResult());
  });

  it("contra-assertion: a busy leaf with NO call in flight (hook disarmed — e.g. running a tool between calls) queues without interrupted", async () => {
    const barrier = deferred<CollectResult>();
    // A boxed holder, not a bare `let` — see the sibling comment in
    // tests/conversation-runtime-injection.test.ts for why a bare `let (()
    // => void) | null = null` read via `?.()` after only ever being
    // assigned INSIDE a nested closure narrows to literal `null` and fails
    // to typecheck (`NonNullable<null>` is `never`).
    const hook: { disarm: (() => void) | null } = { disarm: null };
    const core = new OrchestrationCore({
      runChild: (
        _subId,
        _config,
        _systemPrompt,
        _drainMessages,
        _signal,
        interrupts?: Interrupts,
      ) => {
        hook.disarm =
          interrupts?.arm(() => {
            throw new Error("must never fire: the hook was disarmed before steer() ran");
          }) ?? null;
        return barrier.promise;
      },
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const { subId } = core.spawn({ prompt: "task" });
    await flushMicrotasks();
    hook.disarm?.(); // simulates the call settling — the leaf is now "between calls"

    const outcome = core.steer(subId, "STEER-TEXT");
    expect(outcome).toEqual({ queued: true });
    expect(outcome && "interrupted" in outcome).toBe(false);

    barrier.resolve(okResult());
  });
});
