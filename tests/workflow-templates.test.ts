// Issue #464 (M11-S6, épico #458): the operator's on-disk workflow template
// library — `src/workflow/templates.ts` (new): `templateLoader`,
// `listTemplates`, `workflowTemplatesHandler`. Every reference to that
// module is a DYNAMIC `import()` INSIDE each `it` — the module does not
// exist on `main` yet, and a static top-level import would fail vitest's
// COLLECTION of this whole file (a structural red for every test here)
// instead of a real assertion failure one test at a time (worktree-segura
// §7; controle-negativo's assertion-red vs structural-red, #48/#54).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { usage } from "../src/pricing/usage.js";
import { LockRepository, openStateDatabase, WorkflowRepository } from "../src/state/index.js";
import { WorkflowService } from "../src/workflow/service.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function operatorHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  roots.push(home);
  return home;
}

function writeTemplate(home: string, ref: string, spec: unknown): void {
  const dir = join(home, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ref}.json`), JSON.stringify(spec), "utf8");
}

const innerAgentSpec = {
  meta: { name: "inner-agent" },
  nodes: [{ id: "a", type: "agent", prompt: "do the thing" }],
};

/** Shape of `src/workflow/templates.ts`'s exports, asserted rather than
 * statically imported (`as unknown as TemplatesModule`, same convention as
 * `tests/workflow-cache-stamp.test.ts:95`) — the module does not exist on
 * `main` yet, and TypeScript resolves an unresolvable dynamic `import()`
 * specifier to `any` rather than a compile error; the cast is what keeps
 * every use of the result out of `@typescript-eslint/no-unsafe-*`. */
interface TemplateListingLike {
  readonly ref: string;
  readonly name?: string;
  readonly nodes?: number;
  readonly error?: string;
}
interface TemplatesModule {
  readonly templateLoader: (home: string) => (ref: string) => unknown;
  readonly listTemplates: (home: string) => readonly TemplateListingLike[];
  readonly workflowTemplatesHandler: (
    home: string,
  ) => (args: Readonly<Record<string, unknown>>) => string | Promise<string>;
}

async function importTemplates(): Promise<TemplatesModule> {
  const loaded: unknown = await import("../src/workflow/templates.js");
  return loaded as TemplatesModule;
}

/** Never spawns — used by the "refused at launch" test, where `start()`
 * must fail before the engine ever reaches a leaf. */
function neverSpawnRuntime(): ChildRuntime {
  return {
    spawn: (): never => {
      throw new Error("must not spawn — launch should have been refused first");
    },
    collect: (): ChildResult => ({ status: "failed", output: null }),
    steer: (): void => undefined,
    cancel: (): void => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: (): void => undefined }),
  };
}

/** Same shape as `LabeledRuntime` in `tests/workflow-parallel-cells.test.ts`
 * (#332's own molde) — each spawn gets its own labeled output, so two
 * siblings sharing one `ref` collide iff they end up on the SAME cell. */
class LabeledRuntime implements ChildRuntime {
  readonly requests: ChildSpawnRequest[] = [];

  spawn(request: ChildSpawnRequest): string {
    this.requests.push(request);
    return `leaf-${String(this.requests.length)}`;
  }

  collect(id: string): ChildResult {
    const index = Number(id.split("-")[1]);
    return {
      status: "complete",
      output: `out-${String(index)}`,
      usage: usage({ inputTokens: 4, outputTokens: 4 }),
    };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): LeafSandboxHandle {
    return { dispose: (): void => undefined };
  }
}

describe("templateLoader (#464)", () => {
  it("loads a valid template as the raw parsed JSON", async () => {
    const home = operatorHome("lohra-templates-valid-");
    writeTemplate(home, "inner", innerAgentSpec);
    const { templateLoader } = await importTemplates();
    const raw = templateLoader(home)("inner");
    expect(raw).toEqual(innerAgentSpec);
  });

  it("throws a named error citing the path for an absent ref", async () => {
    const home = operatorHome("lohra-templates-absent-");
    const { templateLoader } = await importTemplates();
    expect(() => templateLoader(home)("missing")).toThrow(/missing.*not found/);
  });

  it("throws citing the reason for invalid JSON", async () => {
    const home = operatorHome("lohra-templates-badjson-");
    const dir = join(home, "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
    const { templateLoader } = await importTemplates();
    expect(() => templateLoader(home)("broken")).toThrow(/not valid JSON/);
  });

  it("refuses a ref with a path separator (../x)", async () => {
    const home = operatorHome("lohra-templates-traversal-");
    const { templateLoader } = await importTemplates();
    expect(() => templateLoader(home)("../x")).toThrow(/invalid ref format/);
  });

  it("refuses a ref with a space (A B)", async () => {
    const home = operatorHome("lohra-templates-space-");
    const { templateLoader } = await importTemplates();
    expect(() => templateLoader(home)("A B")).toThrow(/invalid ref format/);
  });

  it("refuses a ref longer than 64 characters", async () => {
    const home = operatorHome("lohra-templates-long-");
    const { templateLoader } = await importTemplates();
    const ref = "a".repeat(65);
    expect(() => templateLoader(home)(ref)).toThrow(/invalid ref format/);
  });
});

describe("listTemplates (#464)", () => {
  it("returns an empty list for an absent directory", async () => {
    const home = operatorHome("lohra-templates-nodir-");
    const { listTemplates } = await importTemplates();
    expect(listTemplates(home)).toEqual([]);
  });

  it("lists a valid template and never drops a broken one", async () => {
    const home = operatorHome("lohra-templates-mixed-");
    writeTemplate(home, "inner", innerAgentSpec);
    const dir = join(home, "workflows");
    writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
    const { listTemplates } = await importTemplates();
    const listing = listTemplates(home);
    expect(listing).toContainEqual({ ref: "inner", name: "inner-agent", nodes: 1 });
    const broken = listing.find((entry) => entry.ref === "broken");
    expect(broken?.error).toBeDefined();
  });
});

describe("WorkflowService built like chat.ts, with a real templateLoader (#464)", () => {
  it("refuses a ref outside TEMPLATE_REF's shape at launch, never spawning", async () => {
    const home = operatorHome("lohra-templates-service-refuse-");
    const connection = openStateDatabase(join(home, "state.db"));
    const repository = new WorkflowRepository(connection.database);
    const locks = new LockRepository(connection.database);
    const { templateLoader } = await importTemplates();
    const service = new WorkflowService({
      runtime: neverSpawnRuntime(),
      homeRoot: home,
      loader: templateLoader(home),
      store: {
        repository,
        locks,
        holder: "test",
        ttl: 900,
        ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
        database: connection.database,
      },
    });
    const started = service.start(
      { meta: { name: "outer" }, nodes: [{ id: "sub", type: "workflow", ref: "../x" }] },
      {},
    );
    expect("error" in started).toBe(true);
    if ("error" in started) {
      expect(started.invalid_spec).toBe(true);
      expect(started.error).toContain("../x");
      expect(started.error).toContain("invalid ref format");
    }
    connection.close();
  });

  it("sub1/sub2 sharing one ref via the REAL loader don't collide (#332 in production)", async () => {
    const home = operatorHome("lohra-templates-service-siblings-");
    writeTemplate(home, "inner", innerAgentSpec);
    const connection = openStateDatabase(join(home, "state.db"));
    const repository = new WorkflowRepository(connection.database);
    const locks = new LockRepository(connection.database);
    const runtime = new LabeledRuntime();
    const { templateLoader } = await importTemplates();
    const service = new WorkflowService({
      runtime,
      homeRoot: home,
      loader: templateLoader(home),
      store: {
        repository,
        locks,
        holder: "test",
        ttl: 900,
        ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
        database: connection.database,
      },
    });
    const started = service.start(
      {
        meta: { name: "outer-siblings" },
        nodes: [
          { id: "sub1", type: "workflow", ref: "inner" },
          { id: "sub2", type: "workflow", ref: "inner", depends_on: ["sub1"] },
        ],
      },
      {},
    );
    if ("error" in started) throw new Error(started.error);
    const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(final.status).toBe("complete");
    const outputs = final.outputs as Record<string, unknown>;
    expect(outputs.sub1).toBeDefined();
    expect(outputs.sub2).toBeDefined();
    expect(outputs.sub1).not.toEqual(outputs.sub2);
    connection.close();
  });
});

describe("workflowTemplatesHandler (#464)", () => {
  it("lists templates when 'name' is omitted", async () => {
    const home = operatorHome("lohra-templates-tool-list-");
    writeTemplate(home, "inner", innerAgentSpec);
    const { workflowTemplatesHandler } = await importTemplates();
    const handler = workflowTemplatesHandler(home);
    const raw = await handler({});
    const parsed = JSON.parse(raw) as { templates: readonly { ref: string }[] };
    expect(parsed.templates.map((entry) => entry.ref)).toContain("inner");
  });

  it("returns the validated spec for a known 'name'", async () => {
    const home = operatorHome("lohra-templates-tool-get-");
    writeTemplate(home, "inner", innerAgentSpec);
    const { workflowTemplatesHandler } = await importTemplates();
    const handler = workflowTemplatesHandler(home);
    const raw = await handler({ name: "inner" });
    const parsed = JSON.parse(raw) as { ref: string; spec: unknown };
    expect(parsed.ref).toBe("inner");
    expect(parsed.spec).toEqual(innerAgentSpec);
  });

  it("returns a toolError citing the issues for an invalid template", async () => {
    const home = operatorHome("lohra-templates-tool-invalid-");
    writeTemplate(home, "broken-spec", { meta: {}, nodes: [] });
    const { workflowTemplatesHandler } = await importTemplates();
    const handler = workflowTemplatesHandler(home);
    const raw = await handler({ name: "broken-spec" });
    const parsed = JSON.parse(raw) as { error?: string };
    expect(parsed.error).toBeDefined();
  });
});
