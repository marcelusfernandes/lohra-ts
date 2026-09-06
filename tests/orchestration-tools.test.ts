import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/agent/client-pool.js";
import { pythonRepr } from "../src/serialization/python-repr.js";
import { toolError, toolResult } from "../src/tools/envelope.js";
import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";
import {
  collectSessionTool,
  delegateTaskTool,
  spawnSessionTool,
  steerSessionTool,
  type ProviderResolver,
} from "../src/orchestration/tools.js";

const allowAllProviders: ProviderResolver = {
  get: () => Promise.resolve([{}, {}]),
};

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";

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

function makeCore(
  runChild: ConstructorParameters<typeof OrchestrationCore>[0]["runChild"],
  idSource: () => string = () => "aaaa",
): OrchestrationCore {
  return new OrchestrationCore({
    runChild,
    idSource,
    maxSubsessions: 200,
    maxParallel: 200,
    buildSubagentPrompt: stubPrompt,
  });
}

describe("spawnSessionTool", () => {
  it("returns the byte-exact success envelope", async () => {
    const core = makeCore(() => Promise.resolve(okResult()));
    expect(await spawnSessionTool(core, allowAllProviders, { prompt: "do the thing" })).toBe(
      toolResult(undefined, { sub_id: "aaaa" }),
    );
  });

  it("rejects an empty prompt without spawning", async () => {
    const core = makeCore(() => Promise.resolve(okResult()));
    expect(await spawnSessionTool(core, allowAllProviders, { prompt: "" })).toBe(
      toolError("spawn_session requires a non-empty 'prompt'"),
    );
    expect(core.size).toBe(0);
  });

  it("rejects an out-of-range max_iterations without spawning", async () => {
    const core = makeCore(() => Promise.resolve(okResult()));
    expect(
      await spawnSessionTool(core, allowAllProviders, { prompt: "x", max_iterations: 0 }),
    ).toBe(toolError("'max_iterations' must be between 1 and 128 (got 0)"));
    expect(core.size).toBe(0);
  });

  it("threads model/provider/effort/max_iterations through to the spawned config", async () => {
    const received: unknown[] = [];
    const core = makeCore((_subId, config) => {
      received.push(config);
      return Promise.resolve(okResult());
    });
    await spawnSessionTool(core, allowAllProviders, {
      prompt: "x",
      model: "fake-model-b",
      max_iterations: 5,
    });
    // runChild is gated (deferred by at least one microtask tick), so the
    // side effect needs a flush before it's observable.
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(received[0]).toEqual({ prompt: "x", model: "fake-model-b", maxIterations: 5 });
  });

  describe("egress tripwire (L13/assertion 35)", () => {
    it("refuses an unknown provider before spawning — zero registry rows, zero pool calls beyond the check", async () => {
      const core = makeCore(() => Promise.resolve(okResult()));
      const calls: string[] = [];
      const resolver: ProviderResolver = {
        get: (name) => {
          calls.push(name);
          return Promise.reject(new ProviderError(`unknown provider '${name}'`));
        },
      };

      const envelope = await spawnSessionTool(core, resolver, {
        prompt: "x",
        provider: "nope-xyz",
      });

      expect(envelope).toBe(toolError("unknown provider 'nope-xyz'"));
      expect(core.size).toBe(0);
      expect(calls).toEqual(["nope-xyz"]);
    });

    it("refuses a provider with no configured API key before spawning — zero registry rows", async () => {
      const core = makeCore(() => Promise.resolve(okResult()));
      const resolver: ProviderResolver = {
        get: (name) =>
          Promise.reject(new ProviderError(`no API key configured for provider '${name}'`)),
      };

      const envelope = await spawnSessionTool(core, resolver, {
        prompt: "x",
        provider: "openai",
      });

      expect(envelope).toBe(toolError("no API key configured for provider 'openai'"));
      expect(core.size).toBe(0);
    });

    it("does not pre-check the pool at all when provider is absent or an empty string (L18's truthy-escape convention)", async () => {
      let idCalls = 0;
      const core = makeCore(
        () => Promise.resolve(okResult()),
        () => {
          idCalls += 1;
          return `id-${String(idCalls)}`;
        },
      );
      let calls = 0;
      const resolver: ProviderResolver = {
        get: () => {
          calls += 1;
          return Promise.reject(new ProviderError("should never be called"));
        },
      };

      await spawnSessionTool(core, resolver, { prompt: "x" });
      await spawnSessionTool(core, resolver, { prompt: "y", provider: "" });

      expect(calls).toBe(0);
      expect(core.size).toBe(2);
    });

    it("re-throws a non-ProviderError from the pool instead of swallowing it into a tool_error", async () => {
      const core = makeCore(() => Promise.resolve(okResult()));
      const resolver: ProviderResolver = {
        get: () => Promise.reject(new Error("unexpected pool failure")),
      };

      await expect(
        spawnSessionTool(core, resolver, { prompt: "x", provider: "openai" }),
      ).rejects.toThrow("unexpected pool failure");
      expect(core.size).toBe(0);
    });
  });
});

describe("steerSessionTool", () => {
  it("returns the byte-exact queued:true envelope while busy", async () => {
    const core = makeCore(() => new Promise(() => undefined));
    await spawnSessionTool(core, allowAllProviders, { prompt: "x" });
    expect(steerSessionTool(core, { sub_id: "aaaa", text: "hi" })).toBe(
      toolResult(undefined, { queued: true }),
    );
  });

  it("returns the byte-exact no-sub-session error, single-quoted, for an unknown sub_id", () => {
    const core = makeCore(() => Promise.resolve(okResult()));
    expect(steerSessionTool(core, { sub_id: "deadbeef", text: "hi" })).toBe(
      toolError(`no sub-session ${pythonRepr("deadbeef")}`),
    );
  });

  it("rejects missing text without touching the registry", async () => {
    const core = makeCore(() => Promise.resolve(okResult()));
    await spawnSessionTool(core, allowAllProviders, { prompt: "x" });
    expect(steerSessionTool(core, { sub_id: "aaaa" })).toBe(
      toolError("steer_session requires 'sub_id' and a non-empty 'text'"),
    );
  });
});

describe("collectSessionTool", () => {
  it("returns the byte-exact 13-key success envelope in the contract's exact key order", async () => {
    const core = makeCore(() =>
      Promise.resolve(
        okResult({
          output: "…",
          tokensIn: 11,
          tokensOut: 7,
        }),
      ),
    );
    await spawnSessionTool(core, allowAllProviders, { prompt: "x" });
    const envelope = await collectSessionTool(core, { sub_id: "aaaa", wait: true });
    expect(envelope).toBe(
      toolResult(undefined, {
        status: "complete",
        output: "…",
        tokens_in: 11,
        tokens_out: 7,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        provider: "fakeprov",
        model: "fake-model-a",
        forced_fallback: false,
        error_kind: null,
        retry_after: null,
      }),
    );
  });

  it("keeps ok:true alongside status:error when the child failed (L14)", async () => {
    const core = makeCore(() =>
      Promise.resolve(
        okResult({
          status: "error",
          output: "Error code: 418 - {'error': {'message': 'canary'}}",
        }),
      ),
    );
    await spawnSessionTool(core, allowAllProviders, { prompt: "x" });
    const envelope = await collectSessionTool(core, { sub_id: "aaaa", wait: true });
    const parsed = JSON.parse(envelope) as { ok: boolean; status: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("error");
  });

  it("renders a non-null retry_after as a Python-style float, never a bare integer (L15/assertion 39)", async () => {
    const core = makeCore(() =>
      Promise.resolve(
        okResult({
          status: "error",
          errorKind: "quota_exhausted",
          retryAfter: 1,
        }),
      ),
    );
    await spawnSessionTool(core, allowAllProviders, { prompt: "x" });
    const envelope = await collectSessionTool(core, { sub_id: "aaaa", wait: true });
    expect(envelope).toContain('"retry_after":1.0');
    expect(envelope).not.toContain('"retry_after":1,');
    expect(envelope).not.toContain('"retry_after":1}');
  });

  it("coerces a numeric sub_id to string before the no-sub-session repr (L19)", async () => {
    const core = makeCore(() => Promise.resolve(okResult()));
    expect(await collectSessionTool(core, { sub_id: 7, wait: true })).toBe(
      toolError(`no sub-session ${pythonRepr("7")}`),
    );
  });

  it("rejects a missing sub_id without ever calling collect", async () => {
    const core = makeCore(() => Promise.resolve(okResult()));
    expect(await collectSessionTool(core, {})).toBe(
      toolError("collect_session requires a 'sub_id'"),
    );
  });
});

describe("delegateTaskTool", () => {
  it("returns the byte-exact batch envelope with results in task order", async () => {
    let n = 0;
    const core = makeCore(
      (_subId, config) => Promise.resolve(okResult({ output: `${config.prompt}-OUT` })),
      () => {
        n += 1;
        return `kid-${String(n)}`;
      },
    );
    const envelope = await delegateTaskTool(core, { tasks: ["a", "b"] });
    expect(envelope).toBe(
      toolResult(undefined, {
        results: [
          { sub_id: "kid-1", status: "complete", summary: "a-OUT" },
          { sub_id: "kid-2", status: "complete", summary: "b-OUT" },
        ],
      }),
    );
  });

  it("rejects an empty task list without spawning anything", async () => {
    const core = makeCore(() => Promise.resolve(okResult()));
    expect(await delegateTaskTool(core, { tasks: [] })).toBe(
      toolError("'tasks' must be a non-empty list of task descriptions"),
    );
    expect(core.size).toBe(0);
  });

  it("resumes an existing sub-session via steer+collect instead of spawning when resume_id is present", async () => {
    let runChildCalls = 0;
    const core = makeCore((_subId, config) => {
      runChildCalls += 1;
      return Promise.resolve(okResult({ output: `OUTPUT-FOR-${config.prompt}` }));
    });
    await spawnSessionTool(core, allowAllProviders, { prompt: "first task" });
    await collectSessionTool(core, { sub_id: "aaaa", wait: true }); // now idle/terminal

    const envelope = await delegateTaskTool(core, {
      tasks: ["follow-up"],
      resume_id: "aaaa",
    });
    // Two runChild calls total (the original spawn, then the resume's own
    // turn) but only ONE sub_id ever existed — no NEW child was spawned by
    // the resume path.
    expect(runChildCalls).toBe(2);
    expect(core.size).toBe(1);
    expect(envelope).toBe(
      toolResult(undefined, {
        results: [{ sub_id: "aaaa", status: "complete", summary: "OUTPUT-FOR-follow-up" }],
      }),
    );
  });

  it("rejects a provider override during resume (L18)", async () => {
    const core = makeCore(() => Promise.resolve(okResult()));
    await spawnSessionTool(core, allowAllProviders, { prompt: "x" });
    await collectSessionTool(core, { sub_id: "aaaa", wait: true });
    expect(
      await delegateTaskTool(core, { tasks: ["y"], resume_id: "aaaa", provider: "fakeprov" }),
    ).toBe(toolError("cannot switch provider when resuming a subagent"));
  });
});
