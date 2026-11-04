// Issue #970 (épico #969): `workflow_save` keeps a workflow the orchestrator
// authored and ran to `complete` as a template in `<home>/workflows/`.
// `src/workflow/template-save.ts` is new — every reference to it is a
// DYNAMIC `import()` inside each `it` (same convention as
// `tests/workflow-templates.test.ts:1-8`), so against `main` each case fails
// on its own instead of failing this file's collection.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { composeSessionTools, createSessionToolBase } from "../src/commands/session-tools.js";
import { usage } from "../src/pricing/usage.js";
import {
  LockRepository,
  openStateDatabase,
  SessionRepository,
  WorkflowRepository,
} from "../src/state/index.js";
import { CHILD_EXCLUDED_TOOLS } from "../src/tools/child.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import { WorkflowService } from "../src/workflow/service.js";
import { listTemplates, templateLoader } from "../src/workflow/templates.js";

interface SavableRunLike {
  readonly status: string;
  readonly spec: Readonly<Record<string, unknown>> | null;
}
type Lookup = (runId: string) => SavableRunLike | null;
interface SaveModule {
  readonly MAX_AGENT_TEMPLATES: number;
  readonly MAX_TEMPLATE_BYTES: number;
  readonly saveTemplate: (
    home: string,
    lookup: Lookup,
    loader: ((ref: string) => unknown) | undefined,
    request: { runId: string; ref: string; description: string },
    now?: () => Date,
  ) => { ref: string; path: string; name: string; nodes: number; warning?: string };
  readonly publishTemplateFile: (
    dir: string,
    ref: string,
    content: string,
  ) => { path: string; warning?: string };
  readonly workflowSaveHandler: (
    home: string,
    lookup: Lookup,
    loader: ((ref: string) => unknown) | undefined,
    now?: () => Date,
  ) => (args: Readonly<Record<string, unknown>>) => string | Promise<string>;
}

async function importSave(): Promise<SaveModule> {
  const loaded: unknown = await import("../src/workflow/template-save.js");
  return loaded as SaveModule;
}

const roots: string[] = [];
const connections: ReturnType<typeof openStateDatabase>[] = [];
afterEach(() => {
  const failures: unknown[] = [];
  for (const connection of connections.splice(0).reverse()) {
    try {
      connection.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const root of roots.splice(0).reverse()) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1) throw new AggregateError(failures, "template save cleanup failed");
  if (failures.length === 1) throw failures[0];
});

function operatorHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  roots.push(home);
  return home;
}

function libraryDir(home: string): string {
  return join(home, "workflows");
}

function libraryFiles(home: string): string[] {
  const dir = libraryDir(home);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function writeTemplate(home: string, ref: string, spec: unknown): void {
  mkdirSync(libraryDir(home), { recursive: true });
  writeFileSync(join(libraryDir(home), `${ref}.json`), JSON.stringify(spec), "utf8");
}

const authoredSpec = {
  meta: { name: "triage" },
  nodes: [
    { id: "scan", type: "agent", prompt: "list the open bugs in ${args.repo}" },
    { id: "rank", type: "agent", prompt: "rank ${scan}", depends_on: ["scan"] },
  ],
};

const completeRun: Lookup = (runId) =>
  runId === "run-1" ? { status: "complete", spec: authoredSpec } : null;

const FIXED_NOW = (): Date => new Date("2026-11-04T12:00:00.000Z");

describe("saveTemplate (#970)", () => {
  it("writes the run's spec with meta.origin and meta.description", async () => {
    const home = operatorHome("lohra-save-ok-");
    const { saveTemplate } = await importSave();
    const saved = saveTemplate(
      home,
      completeRun,
      templateLoader(home),
      { runId: "run-1", ref: "triage", description: "  triage open bugs  " },
      FIXED_NOW,
    );
    expect(saved).toMatchObject({ ref: "triage", name: "triage", nodes: 2 });
    expect(saved.path).toBe(join(libraryDir(home), "triage.json"));
    const written = JSON.parse(readFileSync(saved.path, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({
      ...authoredSpec,
      meta: {
        name: "triage",
        description: "triage open bugs",
        origin: { by: "agent", run_id: "run-1", saved_at: "2026-11-04T12:00:00.000Z" },
      },
    });
    expect(libraryFiles(home)).toEqual(["triage.json"]);
  });

  it("resolves through templateLoader and lists with origin agent and the description", async () => {
    const home = operatorHome("lohra-save-list-");
    writeTemplate(home, "operator-one", {
      meta: { name: "op" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const { saveTemplate } = await importSave();
    saveTemplate(home, completeRun, templateLoader(home), {
      runId: "run-1",
      ref: "triage",
      description: "triage open bugs",
    });
    expect(templateLoader(home)("triage")).toMatchObject({ nodes: authoredSpec.nodes });
    expect(listTemplates(home)).toEqual([
      { ref: "operator-one", name: "op", nodes: 1, origin: "operator" },
      {
        ref: "triage",
        name: "triage",
        nodes: 2,
        origin: "agent",
        description: "triage open bugs",
      },
    ]);
  });

  it.each([
    ["an unknown run", "nope", "triage", "d", /unknown workflow run 'nope'/],
    ["an invalid ref (path)", "run-1", "../x", "d", /invalid ref '\.\.\/x'/],
    ["an invalid ref (uppercase)", "run-1", "Triage", "d", /invalid ref 'Triage'/],
    ["an empty description", "run-1", "triage", "   ", /'description' must say/],
    ["an oversized description", "run-1", "triage", "x".repeat(1025), /over 1024 characters/],
  ])("refuses %s before touching the disk", async (_label, runId, ref, description, message) => {
    const home = operatorHome("lohra-save-refuse-");
    const { saveTemplate } = await importSave();
    expect(() =>
      saveTemplate(home, completeRun, templateLoader(home), { runId, ref, description }),
    ).toThrow(message);
    expect(libraryFiles(home)).toEqual([]);
  });

  it.each(["failed", "degraded", "paused", "running", "cancelled"])(
    "refuses a '%s' run — only complete runs are saved",
    async (status) => {
      const home = operatorHome("lohra-save-status-");
      const { saveTemplate } = await importSave();
      const lookup: Lookup = () => ({ status, spec: authoredSpec });
      expect(() =>
        saveTemplate(home, lookup, templateLoader(home), {
          runId: "run-1",
          ref: "triage",
          description: "d",
        }),
      ).toThrow(new RegExp(`is '${status}' — only a 'complete' run`));
      expect(libraryFiles(home)).toEqual([]);
    },
  );

  it("refuses a run with no spec on file", async () => {
    const home = operatorHome("lohra-save-nospec-");
    const { saveTemplate } = await importSave();
    expect(() =>
      saveTemplate(home, () => ({ status: "complete", spec: null }), undefined, {
        runId: "run-1",
        ref: "triage",
        description: "d",
      }),
    ).toThrow(/no spec on file for workflow run 'run-1'/);
    expect(libraryFiles(home)).toEqual([]);
  });

  it("refuses an existing ref and leaves the operator's file untouched", async () => {
    const home = operatorHome("lohra-save-exists-");
    const original = { meta: { name: "op" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] };
    writeTemplate(home, "triage", original);
    const before = readFileSync(join(libraryDir(home), "triage.json"), "utf8");
    const { saveTemplate } = await importSave();
    expect(() =>
      saveTemplate(home, completeRun, templateLoader(home), {
        runId: "run-1",
        ref: "triage",
        description: "d",
      }),
    ).toThrow(/template 'triage' already exists — save under a new ref/);
    expect(readFileSync(join(libraryDir(home), "triage.json"), "utf8")).toBe(before);
    expect(libraryFiles(home)).toEqual(["triage.json"]);
  });

  it("refuses a spec that fails validation", async () => {
    const home = operatorHome("lohra-save-invalid-");
    const { saveTemplate } = await importSave();
    const lookup: Lookup = () => ({ status: "complete", spec: { meta: { name: "x" }, nodes: [] } });
    expect(() =>
      saveTemplate(home, lookup, templateLoader(home), {
        runId: "run-1",
        ref: "triage",
        description: "d",
      }),
    ).toThrow(/spec is not a valid template: .*non-empty 'nodes'/);
    expect(libraryFiles(home)).toEqual([]);
  });

  it("refuses a spec whose nested ref no longer resolves", async () => {
    const home = operatorHome("lohra-save-nested-");
    const { saveTemplate } = await importSave();
    const lookup: Lookup = () => ({
      status: "complete",
      spec: { meta: { name: "outer" }, nodes: [{ id: "sub", type: "workflow", ref: "gone" }] },
    });
    expect(() =>
      saveTemplate(home, lookup, templateLoader(home), {
        runId: "run-1",
        ref: "outer",
        description: "d",
      }),
    ).toThrow(/spec is not a valid template: .*gone/);
    expect(libraryFiles(home)).toEqual([]);
  });

  it("refuses a template over the byte cap", async () => {
    const home = operatorHome("lohra-save-big-");
    const { saveTemplate, MAX_TEMPLATE_BYTES } = await importSave();
    const lookup: Lookup = () => ({
      status: "complete",
      spec: {
        meta: { name: "big" },
        nodes: [{ id: "a", type: "agent", prompt: "p".repeat(MAX_TEMPLATE_BYTES) }],
      },
    });
    expect(() =>
      saveTemplate(home, lookup, undefined, { runId: "run-1", ref: "big", description: "d" }),
    ).toThrow(/bytes, over the 256000-byte cap/);
    expect(libraryFiles(home)).toEqual([]);
  });

  it("refuses once the agent already holds the cap of saved templates (operator files don't count)", async () => {
    const home = operatorHome("lohra-save-cap-");
    const { saveTemplate, MAX_AGENT_TEMPLATES } = await importSave();
    const one = { meta: { name: "n" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] };
    for (let index = 0; index < MAX_AGENT_TEMPLATES; index += 1) {
      writeTemplate(home, `agent-${String(index)}`, {
        ...one,
        meta: { name: "n", origin: { by: "agent" } },
      });
    }
    writeTemplate(home, "operator-only", one);
    expect(() =>
      saveTemplate(home, completeRun, undefined, {
        runId: "run-1",
        ref: "triage",
        description: "d",
      }),
    ).toThrow(/already holds 100 agent-saved templates \(cap 100\)/);
    expect(existsSync(join(libraryDir(home), "triage.json"))).toBe(false);
  });
});

describe("publishTemplateFile (#970)", () => {
  it("of two publishes of one ref, exactly one wins and no temporary file is left", async () => {
    const home = operatorHome("lohra-save-race-");
    const { publishTemplateFile } = await importSave();
    const dir = libraryDir(home);
    const first = publishTemplateFile(dir, "triage", '{"first":true}\n');
    expect(first.path).toBe(join(dir, "triage.json"));
    expect(() => publishTemplateFile(dir, "triage", '{"second":true}\n')).toThrow(
      /template 'triage' already exists/,
    );
    expect(readFileSync(join(dir, "triage.json"), "utf8")).toBe('{"first":true}\n');
    expect(readdirSync(dir)).toEqual(["triage.json"]);
  });
});

describe("workflowSaveHandler (#970)", () => {
  it("returns the saved template in the envelope", async () => {
    const home = operatorHome("lohra-save-handler-");
    const { workflowSaveHandler } = await importSave();
    const handler = workflowSaveHandler(home, completeRun, templateLoader(home), FIXED_NOW);
    const parsed = JSON.parse(
      await handler({ run_id: "run-1", ref: "triage", description: "triage open bugs" }),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, saved: true, ref: "triage", nodes: 2 });
  });

  it.each([
    [{ ref: "triage", description: "d" }, /requires 'run_id'/],
    [{ run_id: "run-1", description: "d" }, /requires 'ref'/],
    [{ run_id: "run-1", ref: "triage" }, /requires 'description'/],
    [{ run_id: "nope", ref: "triage", description: "d" }, /unknown workflow run 'nope'/],
  ])("answers a named toolError for %o", async (args, message) => {
    const home = operatorHome("lohra-save-handler-refuse-");
    const { workflowSaveHandler } = await importSave();
    const parsed = JSON.parse(
      await workflowSaveHandler(home, completeRun, templateLoader(home))(args),
    ) as { error?: string };
    expect(parsed.error).toMatch(message);
    expect(libraryFiles(home)).toEqual([]);
  });
});

describe("workflow_save is never a leaf tool (#970)", () => {
  it("is in CHILD_EXCLUDED_TOOLS", () => {
    expect(CHILD_EXCLUDED_TOOLS).toContain("workflow_save");
  });
});

/** Each spawn completes with a labeled output — enough for a real run. */
class CompletingRuntime implements ChildRuntime {
  readonly requests: ChildSpawnRequest[] = [];

  spawn(request: ChildSpawnRequest): string {
    this.requests.push(request);
    return `leaf-${String(this.requests.length)}`;
  }

  collect(id: string): ChildResult {
    return {
      status: "complete",
      output: `out-${id}`,
      usage: usage({ inputTokens: 3, outputTokens: 2 }),
    };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): LeafSandboxHandle {
    return { dispose: (): void => undefined };
  }
}

describe("composeSessionTools wires workflow_save end to end (#970)", () => {
  it("runs an inline spec to complete, saves it, and lists it as the agent's", async () => {
    const home = operatorHome("lohra-save-composed-");
    const connection = openStateDatabase(join(home, "state.db"));
    connections.push(connection);
    const workflowService = new WorkflowService({
      runtime: new CompletingRuntime(),
      homeRoot: home,
      loader: templateLoader(home),
      store: {
        repository: new WorkflowRepository(connection.database),
        locks: new LockRepository(connection.database),
        holder: "test",
        ttl: 900,
        ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
        database: connection.database,
      },
    });
    const tools = composeSessionTools({
      base: createSessionToolBase(connection.database, {}),
      home,
      cwd: home,
      environment: {},
      sessions: new SessionRepository(connection.database, () => 1000, connection.ftsEnabled),
      workflowService,
      orchestrationHandlers: {},
      visionRunner: {
        complete: () => Promise.reject(new Error("unused in this test")),
        close: () => {},
      },
      visionModel: "vision-model",
      supportsVision: false,
    });
    const started = JSON.parse(
      await tools.dispatch("run_workflow", { spec: authoredSpec, args: { repo: "lohra-ts" } }),
    ) as { run_id?: string; error?: string };
    expect(started.error).toBeUndefined();
    const runId = started.run_id as string;
    const final = JSON.parse(
      await tools.dispatch("workflow_status", { run_id: runId, wait: true }),
    ) as {
      status?: string;
    };
    expect(final.status).toBe("complete");

    const saved = JSON.parse(
      await tools.dispatch("workflow_save", {
        run_id: runId,
        ref: "triage",
        description: "triage open bugs",
      }),
    ) as { saved?: boolean; error?: string };
    expect(saved.error).toBeUndefined();
    expect(saved.saved).toBe(true);

    const listed = JSON.parse(await tools.dispatch("workflow_templates", {})) as {
      templates?: readonly Record<string, unknown>[];
    };
    // #973: the composed tool also carries the scoreboard — the source run was
    // inline, so the saved template itself has never run.
    expect(listed.templates).toContainEqual(
      expect.objectContaining({
        ref: "triage",
        name: "triage",
        nodes: 2,
        origin: "agent",
        description: "triage open bugs",
        stats: expect.objectContaining({ runs: 0 }) as unknown,
      }),
    );

    const again = JSON.parse(
      await tools.dispatch("workflow_save", { run_id: runId, ref: "triage", description: "d" }),
    ) as { error?: string };
    expect(again.error).toMatch(/already exists/);
  });
});
