import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { runTiers } from "../src/commands/tiers.js";
import * as tiersModule from "../src/workflow/tiers.js";
import {
  executionTier,
  readTiers,
  TiersError,
  writeTiers,
  type TierMap,
} from "../src/workflow/tiers.js";
import { WorkflowService } from "../src/workflow/service.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "lohra-tiers-test-"));
  roots.push(path);
  return path;
}
function tiersPath(home: string): string {
  return join(home, "workflow_tiers.json");
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function neverRuntime(): ChildRuntime {
  return {
    spawn(): string {
      throw new Error("spawn must not be reached when tiers are invalid");
    },
    collect(): ChildResult {
      throw new Error("collect must not be reached when tiers are invalid");
    },
    steer(): void {
      return undefined;
    },
    cancel(): void {
      return undefined;
    },
  };
}

function validSpec(): Record<string, unknown> {
  return {
    meta: { name: "tiers-fail-closed" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}

describe("readTiers — fail-closed", () => {
  it("returns {} when the file is absent (legitimate)", () => {
    const home = root();
    expect(readTiers(tiersPath(home))).toEqual({});
  });

  it("returns a TiersError, not {}, for invalid JSON", () => {
    const path = tiersPath(root());
    writeFileSync(path, "[");
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).path).toBe(path);
    expect((result as TiersError).message).toContain(path);
  });

  it("returns a TiersError for a non-object root", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify(["small"]));
    expect(readTiers(path)).toBeInstanceOf(TiersError);
  });

  it("returns a TiersError for a known tier with an unknown field", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ small: { model: "m", bogus: "x" } }));
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("bogus");
  });

  it("returns a TiersError for a known tier field with the wrong type", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ small: { model: 123 } }));
    expect(readTiers(path)).toBeInstanceOf(TiersError);
  });

  it("returns a TiersError for a known tier that is neither string nor object", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ small: 123 }));
    expect(readTiers(path)).toBeInstanceOf(TiersError);
  });

  it("returns a TiersError for an empty-string shorthand", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ small: "" }));
    expect(readTiers(path)).toBeInstanceOf(TiersError);
  });

  it("returns a TiersError for a known tier object with no usable field", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ small: {} }));
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("no usable field");
  });

  it("returns a TiersError for a known tier that is null", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ small: null }));
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("null");
  });

  it("returns a TiersError when the path cannot be read for a reason other than absence", () => {
    const home = root();
    const path = tiersPath(home);
    mkdirSync(path);
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("could not be read");
  });

  it("rejects an unknown top-level key even beside a valid tier (fail-closed decision, #261)", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ custom: { model: "ignored" }, small: "shorthand-model" }));
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("custom");
  });

  it("rejects a lone unknown top-level key and suggests the closest tier name (smal → small, #261)", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ smal: { model: "m" } }));
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("smal");
    expect((result as TiersError).message).toContain("did you mean 'small'");
  });

  it("rejects an unknown top-level key with no close match, without a false suggestion (#261)", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ foo: { model: "m" } }));
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("foo");
    expect((result as TiersError).message).not.toContain("did you mean");
  });

  it("rejects an unknown top-level key at edit distance exactly 2 and still suggests the closest tier (boundary, #276)", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ sml: { model: "m" } }));
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("sml");
    expect((result as TiersError).message).toContain("did you mean 'small'");
  });

  it("rejects an unknown top-level key one edit past the boundary (distance 3), without a suggestion (#276)", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ med: { model: "m" } }));
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("med");
    expect((result as TiersError).message).not.toContain("did you mean");
  });

  it("rejects an unknown key before validating a known tier's fields (precedence, #261)", () => {
    const path = tiersPath(root());
    writeFileSync(path, JSON.stringify({ smal: {} }));
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("did you mean 'small'");
    expect((result as TiersError).message).not.toContain("no usable field");
  });

  it("accepts a fully-formed valid tier map", () => {
    const path = tiersPath(root());
    writeFileSync(
      path,
      JSON.stringify({
        small: { provider: "openai", model: "m", effort: "low" },
        big: { provider: "anthropic", model: "b" },
      }),
    );
    expect(readTiers(path)).toEqual({
      small: { provider: "openai", model: "m", effort: "low" },
      big: { provider: "anthropic", model: "b" },
    });
  });
});

describe("loadTiers — removed, no fail-open export left (#261)", () => {
  it("is no longer exported by workflow/tiers.js", () => {
    expect("loadTiers" in tiersModule).toBe(false);
  });
});

describe("WorkflowService.start — refuses a broken tier map", () => {
  it("returns a named {error} instead of launching, and never spawns a leaf", () => {
    const home = root();
    const path = tiersPath(home);
    writeFileSync(path, "[");
    const runtime = neverRuntime();
    const service = new WorkflowService({ runtime, homeRoot: home });
    const result = service.start(validSpec());
    expect(result).toMatchObject({ error: expect.stringContaining(path) as unknown });
    expect(result).not.toHaveProperty("run_id");
  });

  it("launches normally when the tier file is absent", () => {
    const home = root();
    const runtime = {
      spawn: (): string => "leaf-1",
      collect: (): ChildResult => ({
        status: "complete",
        output: { answer: "ok" },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      }),
      steer: (): void => undefined,
      cancel: (): void => undefined,
    };
    const service = new WorkflowService({ runtime, homeRoot: home });
    const result = service.start(validSpec());
    expect(result).toHaveProperty("run_id");
  });
});

function recordingRuntime(): ChildRuntime & { readonly requests: ChildSpawnRequest[] } {
  const requests: ChildSpawnRequest[] = [];
  return {
    requests,
    spawn(request: ChildSpawnRequest): string {
      requests.push(request);
      return `leaf-${String(requests.length)}`;
    },
    collect: (): ChildResult => ({
      status: "complete",
      output: { answer: "ok" },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    }),
    steer: (): void => undefined,
    cancel: (): void => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: (): void => undefined }),
  };
}

describe("WorkflowService — the operator tier map reaches the WorkflowEngine (#258)", () => {
  it("start(): a fresh, non-durable run resolves the node's tier to the mapped model", async () => {
    const home = root();
    writeTiers(tiersPath(home), { big: { model: "x-big" } });
    const runtime = recordingRuntime();
    const service = new WorkflowService({ runtime, homeRoot: home });
    const started = service.start({
      meta: { name: "tiers" },
      nodes: [{ id: "a", type: "agent", prompt: "do it", tier: "big" }],
    });
    if ("error" in started) throw new Error(started.error);
    const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(final.status).toBe("complete");
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.model).toBe("x-big");
  });

  it("resume(): the node's tier still resolves to the mapped model after a checkpoint pause", async () => {
    const home = root();
    writeTiers(tiersPath(home), { big: { model: "x-big" } });
    const runtime = recordingRuntime();
    const connection = openStateDatabase(join(home, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const service = new WorkflowService({
        runtime,
        homeRoot: home,
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
          database: connection.database,
        },
      });
      const started = service.start({
        meta: { name: "tiers-resume" },
        nodes: [
          { id: "cp1", type: "checkpoint", prompt: "answer?", default: "yes" },
          { id: "b", type: "agent", prompt: "go", tier: "big" },
        ],
      });
      if ("error" in started) throw new Error(started.error);
      const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(paused.status).toBe("paused");
      // The checkpoint never spawns a leaf: the first (and only) request is
      // the agent node reached AFTER resume, through `launchDurable`'s
      // WorkflowEngine construction (service.ts, second call site).
      expect(runtime.requests).toHaveLength(0);
      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resumed) throw new Error(resumed.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      expect(runtime.requests).toHaveLength(1);
      expect(runtime.requests[0]?.model).toBe("x-big");
    } finally {
      connection.close();
    }
  });
});

describe("lohra tiers — fail-closed CLI", () => {
  it("reports the native tier path when home ends with a separator", async () => {
    const home = root();
    const path = tiersPath(home);
    writeFileSync(path, "[");
    const result = await runTiers({
      action: "list",
      noInput: true,
      home: `${home}${sep}`,
      environment: {},
      probeOllama: () => Promise.reject(new Error("must not be called")),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(path);
  });

  it("exits 1 with the error on stderr for a broken tier file", async () => {
    const home = root();
    writeFileSync(tiersPath(home), "[");
    const result = await runTiers({
      action: "list",
      noInput: true,
      home,
      environment: {},
      probeOllama: () => Promise.reject(new Error("must not be called")),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(tiersPath(home));
  });

  it("exits 0 when the tier file is absent", async () => {
    const home = root();
    const result = await runTiers({
      action: "list",
      noInput: true,
      home,
      environment: {},
      probeOllama: () => Promise.reject(new Error("must not be called")),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exits 1 on stderr — not stdout — when the file exists but has no known tier (#261)", async () => {
    const home = root();
    writeFileSync(tiersPath(home), "{}");
    const result = await runTiers({
      action: "list",
      noInput: true,
      home,
      environment: {},
      probeOllama: () => Promise.reject(new Error("must not be called")),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(tiersPath(home));
    expect(result.stderr).not.toContain("broken JSON");
  });
});

// Issue #987: a chave `execution` — o tier que nó e sub-agente sem modelo próprio usam.
function tiersFileOf(home: string, content: unknown): string {
  const path = tiersPath(home);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const SMALL: TierMap = {
  small: { model: "x-small", provider: "p-small", effort: "low" },
  medium: { model: "x-medium" },
  big: { model: "x-big" },
  execution: "small",
};

describe("readTiers — a chave `execution` (#987)", () => {
  it("accepts `execution` naming a tier defined in the same file", () => {
    const path = tiersFileOf(root(), { small: { model: "m-small" }, execution: "small" });
    expect(readTiers(path)).toEqual({ small: { model: "m-small" }, execution: "small" });
  });

  it("keeps a file without the key exactly as before (no `execution` property)", () => {
    const path = tiersFileOf(root(), { small: "m-small" });
    const result = readTiers(path);
    expect(result).toEqual({ small: { model: "m-small" } });
    expect(Object.keys(result)).toEqual(["small"]);
  });

  it("refuses a name outside small/medium/big with a named TiersError", () => {
    const path = tiersFileOf(root(), { small: "m", execution: "huge" });
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    const message = (result as TiersError).message;
    expect((result as TiersError).path).toBe(path);
    expect(message).toContain("'execution' must");
    expect(message).toContain("'huge'");
    expect(message).toContain("small, medium, big");
  });

  it("refuses a tier that the file does not define", () => {
    const path = tiersFileOf(root(), { small: "m", execution: "medium" });
    const result = readTiers(path);
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("execution");
    expect((result as TiersError).message).toContain("'medium'");
    expect((result as TiersError).message).toContain("not defined");
  });

  it("refuses `execution` with no tier at all in the file", () => {
    const result = readTiers(tiersFileOf(root(), { execution: "small" }));
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("not defined");
  });

  it.each([[42], [null], [""], [["small"]], [{ tier: "small" }], [true]])(
    "refuses a non-string or empty `execution` (%j)",
    (value) => {
      const result = readTiers(tiersFileOf(root(), { small: "m", execution: value }));
      expect(result).toBeInstanceOf(TiersError);
      expect((result as TiersError).message).toContain("'execution' must");
    },
  );

  it("reports a broken tier before the `execution` that points at it", () => {
    const result = readTiers(tiersFileOf(root(), { small: {}, execution: "small" }));
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("no usable field");
  });

  it("names `execution` among the accepted keys when a top-level key is unknown", () => {
    const result = readTiers(tiersFileOf(root(), { foo: { model: "m" } }));
    expect(result).toBeInstanceOf(TiersError);
    expect((result as TiersError).message).toContain("small, medium, big, execution");
  });

  it("round-trips through writeTiers", () => {
    const path = join(root(), "workflow_tiers.json");
    writeTiers(path, { big: { model: "b" }, execution: "big" });
    expect(readTiers(path)).toEqual({ big: { model: "b" }, execution: "big" });
  });
});

describe("executionTier", () => {
  it("is the tier that `execution` names", () => {
    expect(executionTier(SMALL)).toEqual({ model: "x-small", provider: "p-small", effort: "low" });
    expect(executionTier({ ...SMALL, execution: "big" })).toEqual({ model: "x-big" });
  });

  it("is undefined without the key, or when the named tier is not in the map", () => {
    expect(executionTier({})).toBeUndefined();
    expect(executionTier({ small: { model: "m" } })).toBeUndefined();
    expect(executionTier({ small: { model: "m" }, execution: "big" })).toBeUndefined();
  });
});

describe("lohra tiers list — mostra o `execution` (#987)", () => {
  const list = (home: string): ReturnType<typeof runTiers> =>
    runTiers({
      action: "list",
      noInput: true,
      home,
      environment: {},
      probeOllama: () => Promise.reject(new Error("must not be called")),
    });

  it("prints the execution tier after the tiers", async () => {
    const home = root();
    tiersFileOf(home, { small: { provider: "openai", model: "m-small" }, execution: "small" });
    const result = await list(home);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("small: openai/m-small\nexecution: small\n");
  });

  it("prints nothing about it when the key is absent", async () => {
    const home = root();
    tiersFileOf(home, { small: "m-small" });
    const result = await list(home);
    expect(result.stdout).toBe("small: m-small\n");
  });

  it("exits 1 with the TiersError when `execution` names an undefined tier", async () => {
    const home = root();
    const path = tiersFileOf(home, { small: "m-small", execution: "big" });
    const result = await list(home);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(path);
    expect(result.stderr).toContain("execution");
  });
});
