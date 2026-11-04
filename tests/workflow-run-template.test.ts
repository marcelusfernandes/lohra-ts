// Issue #971 (épico #969): `run_workflow {template: "<ref>"}` runs a library
// template by name and the run records its origin (`template_ref` +
// `template_hash` on `workflow_run_state`) — kept across a resume and an
// ownerless cancel, cleared when a resume sends a different spec, absent for
// an inline spec. `src/workflow/template-run.ts` is new: referenced through a
// DYNAMIC `import()` only, same convention as `tests/workflow-templates.test.ts`.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import { WorkflowService } from "../src/workflow/service.js";
import { templateLoader } from "../src/workflow/templates.js";

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
  if (failures.length > 1) throw new AggregateError(failures, "run-template cleanup failed");
  if (failures.length === 1) throw failures[0];
});

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

const triage = {
  meta: { name: "triage", description: "triage open bugs", origin: { by: "agent" } },
  nodes: [{ id: "scan", type: "agent", prompt: "list the open bugs in ${args.repo}" }],
};

const gated = {
  meta: { name: "gated" },
  nodes: [
    { id: "confirm", type: "checkpoint", prompt: "go?" },
    { id: "work", type: "agent", prompt: "do it after ${confirm}" },
  ],
};

interface Fixture {
  readonly home: string;
  readonly connection: ReturnType<typeof openStateDatabase>;
  readonly runtime: CompletingRuntime;
  readonly service: WorkflowService;
  readonly row: (runId: string) => Record<string, unknown> | null;
}

function writeTemplate(home: string, ref: string, spec: unknown): void {
  const dir = join(home, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ref}.json`), JSON.stringify(spec), "utf8");
}

function serviceOn(
  home: string,
  connection: ReturnType<typeof openStateDatabase>,
): WorkflowService {
  return new WorkflowService({
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
}

function fixture(prefix: string): Fixture {
  const home = mkdtempSync(join(tmpdir(), prefix));
  roots.push(home);
  writeTemplate(home, "triage", triage);
  writeTemplate(home, "gated", gated);
  const connection = openStateDatabase(join(home, "state.db"));
  connections.push(connection);
  const runtime = new CompletingRuntime();
  const service = new WorkflowService({
    runtime,
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
  const repository = new WorkflowRepository(connection.database);
  return { home, connection, runtime, service, row: (runId) => repository.getRunState(runId) };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function settle(service: WorkflowService, runId: string): Promise<Record<string, unknown>> {
  return (await service.status(runId, true)) as Record<string, unknown>;
}

describe("WorkflowService.start({template}) (#971)", () => {
  it("runs the template by ref and records template_ref + template_hash on the run line", async () => {
    const f = fixture("lohra-run-template-ok-");
    const started = f.service.start(null, { repo: "lohra-ts" }, { template: "triage" });
    if ("error" in started) throw new Error(started.error);
    const final = await settle(f.service, started.run_id);
    expect(final.status).toBe("complete");
    expect(final.template_ref).toBe("triage");
    expect(f.runtime.requests[0]?.prompt ?? "").toContain("lohra-ts");
    const row = f.row(started.run_id);
    expect(row?.template_ref).toBe("triage");
    expect(row?.template_hash).toBe(sha256(triage));
    const durable = (await serviceOn(f.home, f.connection).status(started.run_id)) as Record<
      string,
      unknown
    >;
    expect(durable.template_ref).toBe("triage");
  });

  it("leaves both columns NULL and the field absent for an inline spec", async () => {
    const f = fixture("lohra-run-template-inline-");
    const started = f.service.start(triage, { repo: "x" });
    if ("error" in started) throw new Error(started.error);
    const final = await settle(f.service, started.run_id);
    expect(final.status).toBe("complete");
    expect("template_ref" in final).toBe(false);
    expect(f.row(started.run_id)?.template_ref).toBeNull();
    expect(f.row(started.run_id)?.template_hash).toBeNull();
  });

  it.each([
    ["with 'spec'", triage, {}, /'template' and 'spec' are mutually exclusive/],
    ["with 'resume_run_id'", null, { resumeRunId: "r1" }, /not accepted with 'resume_run_id'/],
  ])("refuses 'template' %s before anything starts", (_label, spec, extra, message) => {
    const f = fixture("lohra-run-template-excl-");
    const started = f.service.start(spec, {}, { template: "triage", ...extra });
    expect("error" in started && started.error).toMatch(message);
    expect(f.runtime.requests).toHaveLength(0);
    expect(new WorkflowRepository(f.connection.database).recentRunStates(10)).toHaveLength(0);
  });

  it.each([
    ["an absent ref", "missing", /template 'missing' not found/],
    ["an invalid ref", "../x", /invalid ref format/],
    ["a template that is not valid JSON", "broken", /template 'broken' at .* is not valid JSON/],
  ])("refuses %s as an invalid spec, never spawning", (_label, ref, message) => {
    const f = fixture("lohra-run-template-bad-");
    writeFileSync(join(f.home, "workflows", "broken.json"), "{not json", "utf8");
    const started = f.service.start(null, {}, { template: ref });
    expect("error" in started).toBe(true);
    if ("error" in started) {
      expect(started.error).toMatch(message);
      expect(started.invalid_spec).toBe(true);
    }
    expect(f.runtime.requests).toHaveLength(0);
    expect(new WorkflowRepository(f.connection.database).recentRunStates(10)).toHaveLength(0);
  });

  it("refuses a template whose spec fails validation", () => {
    const f = fixture("lohra-run-template-invalid-");
    writeTemplate(f.home, "empty", { meta: { name: "empty" }, nodes: [] });
    const started = f.service.start(null, {}, { template: "empty" });
    expect("error" in started && started.invalid_spec).toBe(true);
    expect(f.runtime.requests).toHaveLength(0);
  });

  it("keeps template_ref and template_hash across a checkpoint resume", async () => {
    const f = fixture("lohra-run-template-resume-");
    const started = f.service.start(null, {}, { template: "gated" });
    if ("error" in started) throw new Error(started.error);
    expect((await settle(f.service, started.run_id)).status).toBe("paused");
    expect(f.row(started.run_id)?.template_ref).toBe("gated");
    const resumed = f.service.start(
      null,
      {},
      {
        resumeRunId: started.run_id,
        checkpointAnswers: { confirm: "yes" },
      },
    );
    if ("error" in resumed) throw new Error(resumed.error);
    const final = await settle(f.service, started.run_id);
    expect(final.status).toBe("complete");
    expect(final.template_ref).toBe("gated");
    expect(f.row(started.run_id)?.template_ref).toBe("gated");
    expect(f.row(started.run_id)?.template_hash).toBe(sha256(gated));
  });

  it("clears the origin when a resume sends a different spec", async () => {
    const f = fixture("lohra-run-template-respec-");
    const started = f.service.start(null, {}, { template: "gated" });
    if ("error" in started) throw new Error(started.error);
    await settle(f.service, started.run_id);
    const resumed = f.service.start(triage, { repo: "x" }, { resumeRunId: started.run_id });
    if ("error" in resumed) throw new Error(resumed.error);
    const final = await settle(f.service, started.run_id);
    expect(final.status).toBe("complete");
    expect("template_ref" in final).toBe(false);
    expect(f.row(started.run_id)?.template_ref).toBeNull();
  });

  it("keeps the origin through an ownerless cancel of a run known only from its line", async () => {
    const f = fixture("lohra-run-template-cancel-");
    const started = f.service.start(null, {}, { template: "gated" });
    if ("error" in started) throw new Error(started.error);
    await settle(f.service, started.run_id);
    const other = serviceOn(f.home, f.connection);
    const cancelled = await other.cancel(started.run_id);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(f.row(started.run_id)?.status).toBe("cancelled");
    expect(f.row(started.run_id)?.template_ref).toBe("gated");
    expect(f.row(started.run_id)?.template_hash).toBe(sha256(gated));
  });
});

describe("templateHash/launchOrigin (#971)", () => {
  it("hashes the template as loaded and resolves the origin per launch kind", async () => {
    const module = (await import("../src/workflow/template-run.js")) as unknown as {
      templateHash: (raw: unknown) => string;
      launchOrigin: (
        template: { origin: { ref: string; hash: string } } | null,
        explicitSpec: boolean,
        prior: { template_ref: string | null; template_hash: string | null } | null,
        rawSpec?: unknown,
      ) => { ref: string; hash: string } | null;
    };
    expect(module.templateHash(triage)).toBe(sha256(triage));
    const origin = { ref: "a", hash: "h" };
    expect(module.launchOrigin({ origin }, true, null)).toEqual(origin);
    expect(module.launchOrigin(null, false, { template_ref: "b", template_hash: "hb" })).toEqual({
      ref: "b",
      hash: "hb",
    });
    expect(module.launchOrigin(null, true, { template_ref: "b", template_hash: "hb" })).toBeNull();
    // Review R2: re-sending the very template (same hash) keeps the origin.
    const same = { template_ref: "triage", template_hash: sha256(triage) };
    expect(module.launchOrigin(null, true, same, triage)).toEqual({
      ref: "triage",
      hash: sha256(triage),
    });
    expect(module.launchOrigin(null, true, same, { ...triage, meta: { name: "x" } })).toBeNull();
    expect(module.launchOrigin(null, false, null)).toBeNull();
  });
});

describe("run_workflow tool surface (#971)", () => {
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

  it("treats an empty 'template' as absent — a strict-schema caller fills every field", async () => {
    const f = fixture("lohra-run-template-tool-strict-");
    const tools = composed(f);
    const started = JSON.parse(
      await tools.dispatch("run_workflow", { spec: triage, template: "", args: { repo: "x" } }),
    ) as { run_id?: string; error?: string };
    expect(started.error).toBeUndefined();
    const status = JSON.parse(
      await tools.dispatch("workflow_status", { run_id: started.run_id, wait: true }),
    ) as Record<string, unknown>;
    expect(status.status).toBe("complete");
    expect("template_ref" in status).toBe(false);
  });

  it("run_workflow {template} starts the run and workflow_status shows template_ref", async () => {
    const f = fixture("lohra-run-template-tool-");
    const tools = composed(f);
    const started = JSON.parse(
      await tools.dispatch("run_workflow", { template: "triage", args: { repo: "x" } }),
    ) as { run_id?: string; error?: string };
    expect(started.error).toBeUndefined();
    const status = JSON.parse(
      await tools.dispatch("workflow_status", { run_id: started.run_id, wait: true }),
    ) as Record<string, unknown>;
    expect(status).toMatchObject({ status: "complete", template_ref: "triage" });
  });

  it.each([
    [{ template: "" }, /needs a 'spec' object \(with meta \+ nodes\) or a 'template' ref/],
    [{ template: 7 }, /'template' must be a string/],
    [{ template: "triage", spec: triage }, /'template' and 'spec' are mutually exclusive/],
    [{ template: "missing" }, /invalid workflow spec: template 'missing' not found/],
  ])("answers a named toolError for %o", async (args, message) => {
    const f = fixture("lohra-run-template-tool-refuse-");
    const parsed = JSON.parse(await composed(f).dispatch("run_workflow", args)) as {
      error?: string;
    };
    expect(parsed.error).toMatch(message);
    expect(f.runtime.requests).toHaveLength(0);
  });
});
