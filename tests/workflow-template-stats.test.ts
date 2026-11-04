// Issue #973 (épico #969): the per-template scoreboard in `workflow_templates`
// and `lohra workflow templates` — runs by status, last use and average
// tokens, by `template_ref` (#971), from rows that already exist. Inline runs
// never enter it; a template never run shows `runs: 0`; a scoreboard that
// cannot be read never hides the library.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { composeSessionTools, createSessionToolBase } from "../src/commands/session-tools.js";
import { runWorkflowCommand } from "../src/commands/workflow.js";
import { usage } from "../src/pricing/usage.js";
import {
  LockRepository,
  openStateDatabase,
  SessionRepository,
  WorkflowRepository,
} from "../src/state/index.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import { WorkflowService } from "../src/workflow/service.js";
import {
  EMPTY_TEMPLATE_STATS,
  foldTemplateStats,
  type TemplateStats,
} from "../src/workflow/template-stats.js";
import {
  listTemplates,
  templateLoader,
  workflowTemplatesHandler,
} from "../src/workflow/templates.js";

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
  if (failures.length > 1) throw new AggregateError(failures, "template stats cleanup failed");
  if (failures.length === 1) throw failures[0];
});

class CompletingRuntime implements ChildRuntime {
  private spawned = 0;

  spawn(_request: ChildSpawnRequest): string {
    this.spawned += 1;
    return `leaf-${String(this.spawned)}`;
  }

  collect(id: string): ChildResult {
    return {
      status: "complete",
      output: `out-${id}`,
      usage: usage({ inputTokens: 30, outputTokens: 10 }),
    };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): LeafSandboxHandle {
    return { dispose: (): void => undefined };
  }
}

const triage = {
  meta: {
    name: "triage",
    description: "triage open bugs",
    origin: { by: "agent", run_id: "r0", saved_at: "2026-11-04T00:00:00.000Z" },
  },
  nodes: [{ id: "scan", type: "agent", prompt: "scan" }],
};
const gated = {
  meta: { name: "gated" },
  nodes: [
    { id: "confirm", type: "checkpoint", prompt: "go?" },
    { id: "work", type: "agent", prompt: "do it after ${confirm}" },
  ],
};
const unused = { meta: { name: "unused" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] };

interface Fixture {
  readonly home: string;
  readonly connection: ReturnType<typeof openStateDatabase>;
  readonly service: WorkflowService;
}

function fixture(prefix: string): Fixture {
  const home = mkdtempSync(join(tmpdir(), prefix));
  roots.push(home);
  const dir = join(home, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify(triage), "utf8");
  writeFileSync(join(dir, "gated.json"), JSON.stringify(gated), "utf8");
  writeFileSync(join(dir, "unused.json"), JSON.stringify(unused), "utf8");
  const connection = openStateDatabase(join(home, "state.db"));
  connections.push(connection);
  const service = new WorkflowService({
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
  return { home, connection, service };
}

async function run(f: Fixture, spec: unknown, template?: string): Promise<string> {
  const started = f.service.start(spec, {}, template === undefined ? {} : { template });
  if ("error" in started) throw new Error(started.error);
  await f.service.status(started.run_id, true);
  return started.run_id;
}

/** 2 complete runs of `triage`, 1 paused `gated`, 1 inline run (excluded). */
async function seeded(prefix: string): Promise<Fixture> {
  const f = fixture(prefix);
  await run(f, null, "triage");
  await run(f, null, "triage");
  await run(f, null, "gated");
  await run(f, triage);
  return f;
}

function statsOf(entries: readonly Record<string, unknown>[], ref: string): TemplateStats {
  const entry = entries.find((candidate) => candidate.ref === ref);
  return entry?.stats as TemplateStats;
}

describe("foldTemplateStats (#973)", () => {
  it("folds (template, status) rows into one scoreboard per ref", () => {
    const stats = foldTemplateStats([
      { template_ref: "a", status: "complete", runs: 3, last_used_at: 100, tokens: 90 },
      { template_ref: "a", status: "failed", runs: 1, last_used_at: 250, tokens: 11 },
      { template_ref: "a", status: "ownership_lost", runs: 1, last_used_at: 50, tokens: 0 },
      { template_ref: "b", status: "paused", runs: 2, last_used_at: 10, tokens: 5 },
    ]);
    expect(stats.get("a")).toEqual({
      ...EMPTY_TEMPLATE_STATS,
      runs: 5,
      complete: 3,
      failed: 1,
      other: 1,
      last_used_at: 250,
      avg_tokens: 20,
    });
    expect(stats.get("b")).toEqual({
      ...EMPTY_TEMPLATE_STATS,
      runs: 2,
      paused: 2,
      last_used_at: 10,
      avg_tokens: 3,
    });
  });
});

describe("WorkflowRepository.templateRunStats (#973)", () => {
  it("counts template runs by status with their spend, and never inline runs", async () => {
    const f = await seeded("lohra-template-stats-repo-");
    const rows = new WorkflowRepository(f.connection.database).templateRunStats(100);
    expect(rows.map((row) => [row.template_ref, row.status, row.runs])).toEqual([
      ["gated", "paused", 1],
      ["triage", "complete", 2],
    ]);
    const triageRow = rows.find((row) => row.template_ref === "triage");
    expect(triageRow?.tokens).toBe(80);
    expect(triageRow?.last_used_at).toBe(1000);
  });

  it("honors the row limit", async () => {
    const f = await seeded("lohra-template-stats-limit-");
    expect(new WorkflowRepository(f.connection.database).templateRunStats(1)).toHaveLength(1);
  });
});

describe("workflow_templates with the scoreboard (#973)", () => {
  function composed(f: Fixture): ReturnType<typeof composeSessionTools> {
    return composeSessionTools({
      base: createSessionToolBase(f.connection.database, {}),
      home: f.home,
      cwd: f.home,
      environment: {},
      sessions: new SessionRepository(f.connection.database, () => 1000, f.connection.ftsEnabled),
      workflowService: f.service,
      orchestrationHandlers: {},
      visionRunner: {
        complete: () => Promise.reject(new Error("unused in this test")),
        close: () => {},
      },
      visionModel: "vision-model",
      supportsVision: false,
    });
  }

  it("lists each template with origin and stats; a never-run one has runs: 0", async () => {
    const f = await seeded("lohra-template-stats-tool-");
    const parsed = JSON.parse(await composed(f).dispatch("workflow_templates", {})) as {
      templates: readonly Record<string, unknown>[];
    };
    expect(parsed.templates.map((entry) => [entry.ref, entry.origin])).toEqual([
      ["gated", "operator"],
      ["triage", "agent"],
      ["unused", "operator"],
    ]);
    expect(statsOf(parsed.templates, "triage")).toEqual({
      ...EMPTY_TEMPLATE_STATS,
      runs: 2,
      complete: 2,
      last_used_at: 1000,
      avg_tokens: 40,
    });
    expect(statsOf(parsed.templates, "gated")).toMatchObject({ runs: 1, paused: 1 });
    expect(statsOf(parsed.templates, "unused")).toEqual(EMPTY_TEMPLATE_STATS);
  });

  it("still lists the library, and says why, when the scoreboard cannot be read", async () => {
    const f = fixture("lohra-template-stats-broken-");
    const handler = workflowTemplatesHandler(f.home, () => {
      throw new Error("database is locked");
    });
    const parsed = JSON.parse(await handler({})) as {
      templates: readonly Record<string, unknown>[];
      stats_error?: string;
    };
    expect(parsed.templates.map((entry) => entry.ref)).toEqual(["gated", "triage", "unused"]);
    expect(parsed.stats_error).toBe("database is locked");
  });

  it("listTemplates without stats keeps the pre-#973 shape (no stats key)", () => {
    const f = fixture("lohra-template-stats-nostats-");
    expect(listTemplates(f.home).every((entry) => !("stats" in entry))).toBe(true);
  });
});

describe("lohra workflow templates (#973)", () => {
  async function cli(
    home: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const code = await runWorkflowCommand({
      action: "templates",
      databasePath: join(home, "state.db"),
      home,
      args,
      stdout: (value) => {
        out += value;
      },
      stderr: (value) => {
        err += value;
      },
    });
    return { code, out, err };
  }

  it("prints one line per template with origin and scoreboard", async () => {
    const f = await seeded("lohra-template-stats-cli-");
    const { code, out } = await cli(f.home);
    expect(code).toBe(0);
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(
      /^triage {2}agent {2}2 runs {2}2 complete {2}0\/0 degraded\/failed {2}last 1970-01-01 00:16 {2}~40 tok {2}triage$/,
    );
    expect(lines[0]).toMatch(/^gated {2}operator {2}1 runs {2}0 complete/);
    expect(lines[2]).toMatch(/^unused {2}operator {2}0 runs .* last never/);
  });

  it("--json returns the same listing, structured", async () => {
    const f = await seeded("lohra-template-stats-cli-json-");
    const { code, out } = await cli(f.home, { json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { templates: readonly Record<string, unknown>[] };
    expect(statsOf(parsed.templates, "triage")).toMatchObject({ runs: 2, complete: 2 });
  });

  it("says so explicitly for an empty library and keeps a broken file's line", async () => {
    const home = mkdtempSync(join(tmpdir(), "lohra-template-stats-cli-empty-"));
    roots.push(home);
    const empty = await cli(home);
    expect(empty.out).toBe(`no workflow templates in ${join(home, "workflows")}\n`);
    mkdirSync(join(home, "workflows"), { recursive: true });
    writeFileSync(join(home, "workflows", "broken.json"), "{not json", "utf8");
    const broken = await cli(home);
    expect(broken.out).toMatch(/^broken {2}error: .*is not valid JSON/);
  });
});
