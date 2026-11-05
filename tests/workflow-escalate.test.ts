// Issue #981 (S4 do épico #976): o nó `escalate` — pausa o run para revisão só
// quando um predicado (`when`, do S1) vale, com `kind` e `summary`. O que prende:
//   - a validação: `when` válido, `kind` casando ^[a-z][a-z0-9_]{0,31}$, `summary`
//     de 1 a 2000 caracteres, e nenhum knob de roteamento nem `default`;
//   - `when` falso: saída `{escalated:false}`, sem leaf, sem célula, sem fault, e
//     o run segue; um campo ausente de uma raiz presente é só um valor que não vale;
//   - `when` verdadeiro sem resposta: o run termina `paused` com
//     `pauseReason:"escalated"` e o payload `{node_id, kind, summary}`; nada depois
//     do nó roda; o nó não gasta leaf;
//   - com `checkpointAnswers[node_id]`: a saída é `{escalated:true, kind, summary,
//     answer}`, fica em cache (hash pinado) e o nó nunca pergunta de novo — a
//     resposta é do primeiro run, mesmo com outra no resume; um `summary` ou um
//     `kind` mudado é outra pergunta;
//   - a falha FECHA para a pessoa (rodada 2): um `when` que não dá para avaliar
//     (a raiz de um caminho é um nó morto) vale como verdadeiro; um `summary` que
//     lê um valor ausente sai como o template cru atrás de `[unrendered]`, e um em
//     branco atrás de `[empty summary]`; em todos o run pausa `escalated`, o nó
//     seguinte não é spawnado, e o fault nomeia o que faltou. Um `summary`
//     renderizado acima de 2000 caracteres é cortado com `…`;
// O durável (service, lease, status, `lohra workflow`) e o id escopado dentro de um
// `workflow` aninhado (a colisão com a raiz, com um irmão, entre `checkpoint` e
// `escalate`) ficam em `tests/workflow-escalate-durable.test.ts` — este arquivo está
// no teto de linhas; o ledger e o preview, em
// `tests/workflow-cache-preview-flow.test.ts`.
import { describe, expect, it } from "vitest";

import { usage } from "../src/pricing/usage.js";
import { contentHash, MemoryWorkflowCache, type CacheLookup } from "../src/workflow/cache.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { topologicalOrder } from "../src/workflow/graph.js";
import {
  ANSWER_NODE_TYPES,
  ESCALATE_KIND,
  MAX_ESCALATE_SUMMARY,
  NODE_SPECS,
  NODE_TYPES,
} from "../src/workflow/nodes.js";
import { NODE_VALIDATORS, validateEscalate } from "../src/workflow/schema-nodes.js";
import { validateSpec } from "../src/workflow/schema.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import { Node, type SpecIssue, ValidationError, type WorkflowSpec } from "../src/workflow/types.js";

const NAME = "escalate-run";
const DEAD = Symbol("dead leaf");

/** Hands out the scripted outputs in order; a `failed` for `DEAD` or once the script runs dry. */
class ScriptedRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  private readonly pending: unknown[];

  constructor(outputs: readonly unknown[] = []) {
    this.pending = [...outputs];
  }

  spawn(request: ChildSpawnRequest): string {
    this.spawned.push(request);
    return `leaf-${String(this.spawned.length)}`;
  }

  collect(_id: string, _options: ChildCollectOptions): ChildResult {
    const next = this.pending.shift();
    if (next === undefined || next === DEAD) return { status: "failed", output: "dead leaf" };
    const tokens = usage({ inputTokens: 1, outputTokens: 1 });
    return { status: "complete", output: next, usage: tokens, provider: "stub", model: "canned" };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): LeafSandboxHandle {
    return { dispose: (): void => undefined };
  }
}

interface Lookup {
  readonly nodeId: string | undefined;
  readonly hit: boolean;
  readonly miss: CacheLookup["miss"];
}

/** A cache that remembers every lookup and every write, and under which owner. */
class RecordingCache extends MemoryWorkflowCache {
  readonly gets: Lookup[] = [];
  readonly puts: { readonly hash: string; readonly nodeId: string; readonly output: unknown }[] =
    [];

  override get(runId: string, hash: string, nodeId?: string): CacheLookup {
    const found = super.get(runId, hash, nodeId);
    this.gets.push({ nodeId, hit: found.hit, miss: found.miss });
    return found;
  }

  override put(
    runId: string,
    hash: string,
    nodeId: string,
    output: unknown,
    cost: Parameters<MemoryWorkflowCache["put"]>[4],
  ): boolean {
    this.puts.push({ hash, nodeId, output });
    return super.put(runId, hash, nodeId, output, cost);
  }

  of(nodeId: string): { gets: Lookup[]; puts: RecordingCache["puts"] } {
    return {
      gets: this.gets.filter((entry) => entry.nodeId === nodeId),
      puts: this.puts.filter((entry) => entry.nodeId === nodeId),
    };
  }
}

function spec(
  nodes: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): WorkflowSpec {
  const result = validateSpec({ meta: { name: NAME }, nodes, ...extra });
  if ("issues" in result) throw new Error(result.message);
  return result;
}

interface Options {
  readonly cache?: MemoryWorkflowCache;
  readonly answers?: Record<string, unknown>;
  readonly loader?: (ref: string) => unknown;
}

function run(
  runtime: ScriptedRuntime,
  workflow: WorkflowSpec,
  args: Record<string, unknown> = {},
  options: Options = {},
) {
  return new WorkflowEngine({
    runtime,
    runId: "run",
    logError: () => undefined,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.answers === undefined ? {} : { checkpointAnswers: options.answers }),
    ...(options.loader === undefined ? {} : { loader: options.loader }),
  }).run(workflow, args);
}

const SCAN = { id: "scan", type: "agent", prompt: "Scan ${args.text}" };
const SHIP = { id: "ship", type: "agent", prompt: "Ship ${args.text}", depends_on: ["review"] };

const review = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "review",
  type: "escalate",
  when: { gte: { path: "${scan.risk}", n: 7 } },
  kind: "high_risk",
  summary: "Risk ${scan.risk} on ${args.text}",
  ...fields,
});

const ARGS = { text: "hello" };
const SUMMARY = "Risk 9 on hello";

/** The scan -> review -> ship chain; the scan's script decides whether the review fires. */
const chain = (fields: Record<string, unknown> = {}): WorkflowSpec =>
  spec([SCAN, review(fields), SHIP]);

describe("escalate is a registered node type (#981)", () => {
  it("is one of the closed node types, with when, kind and summary required and no routing", () => {
    expect(NODE_TYPES.has("escalate")).toBe(true);
    const nodeSpec = NODE_SPECS.escalate;
    expect([...(nodeSpec?.required ?? [])].sort()).toEqual(["kind", "summary", "when"]);
    for (const field of ["when", "kind", "summary", "required", "depends_on"])
      expect(nodeSpec?.fields).toContain(field);
    for (const field of ["model", "tier", "effort", "provider", "default", "prompt"])
      expect(nodeSpec?.fields).not.toContain(field);
  });

  it("fixes the limits the validation and the skill quote", () => {
    expect(MAX_ESCALATE_SUMMARY).toBe(2000);
    expect(ESCALATE_KIND.test("high_risk")).toBe(true);
    expect(ESCALATE_KIND.test("High")).toBe(false);
  });

  it("registers its validator by type, and a checkpoint is not the only node a human answers", () => {
    expect(NODE_VALIDATORS.get("escalate")).toBe(validateEscalate);
    expect([...ANSWER_NODE_TYPES].sort()).toEqual(["checkpoint", "escalate"]);
  });

  it("validateEscalate ignores every other node type", () => {
    const issues: SpecIssue[] = [];
    validateEscalate(new Node("a", "agent", { prompt: "x" }), issues);
    expect(issues).toEqual([]);
  });
});

function issuesOf(nodes: readonly Record<string, unknown>[]): readonly SpecIssue[] {
  const result = validateSpec({ meta: { name: "escalate" }, nodes });
  return result instanceof ValidationError ? result.issues : [];
}

const escalateIssues = (fields: Record<string, unknown> = {}): readonly SpecIssue[] =>
  issuesOf([SCAN, review(fields)]);

const without = (field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(review()).filter(([key]) => key !== field));

const shape = (issues: readonly SpecIssue[]): string[] =>
  issues.map((issue) => `${issue.rule}:${String(issue.field)}`);

describe("the validation of an escalate (#981)", () => {
  it("accepts the whole node", () => {
    expect(escalateIssues()).toEqual([]);
  });

  it.each(["when", "kind", "summary"])("a node without '%s' is a missing_field", (field) => {
    const issues = issuesOf([SCAN, without(field)]);
    expect(shape(issues)).toEqual([`missing_field:${field}`]);
  });

  describe("when", () => {
    it.each([
      ["a predicate that does not exist", { is_big: { path: "${scan.risk}" } }],
      ["a path that is not one ${ref}", { gte: { path: "scan.risk", n: 1 } }],
      ["a string", "${scan.risk}"],
      ["a number", 3],
      ["a list", [{ field_true: { path: "${scan.ok}" } }]],
    ])("refuses %s", (_label, when) => {
      const issues = escalateIssues({ when });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((issue) => String(issue.field).startsWith("when"))).toBe(true);
    });

    it("names the field of a bad operand: when.gte.n", () => {
      const issues = escalateIssues({ when: { gte: { path: "${scan.risk}", n: "7" } } });
      expect(issues.map((issue) => issue.field)).toContain("when.gte.n");
    });

    it("accepts every predicate the S1 table has, `not` included", () => {
      for (const when of [
        { field_true: { path: "${args.flag}" } },
        { in: { path: "${scan.level}", values: ["high", "critical"] } },
        { not: { of: { empty: { path: "${scan.findings}" } } } },
      ])
        expect(escalateIssues({ when })).toEqual([]);
    });

    it("a ref to a node that does not exist is a ref_target issue", () => {
      const issues = escalateIssues({ when: { gte: { path: "${ghost.risk}", n: 1 } } });
      expect(shape(issues)).toEqual(["ref_target:null"]);
    });
  });

  describe("kind", () => {
    it.each(["a", "needs_review", "high_risk_2", `a${"b".repeat(31)}`])("accepts '%s'", (kind) => {
      expect(escalateIssues({ kind })).toEqual([]);
    });

    it.each([
      ["empty", ""],
      ["upper case", "Needs_review"],
      ["starting with a digit", "1abc"],
      ["starting with an underscore", "_abc"],
      ["with a dash", "needs-review"],
      ["with a space", "needs review"],
      ["with a template", "${scan.risk}"],
      ["33 characters", `a${"b".repeat(32)}`],
      ["not a string", 7],
      ["null", null],
    ])("refuses a kind that is %s", (_label, kind) => {
      const issues = escalateIssues({ kind });
      expect(shape(issues)).toEqual(["field_value:kind"]);
      expect(issues[0]?.message).toContain("^[a-z][a-z0-9_]{0,31}$");
    });
  });

  describe("summary", () => {
    it("accepts one character and exactly 2000", () => {
      expect(escalateIssues({ summary: "x" })).toEqual([]);
      expect(escalateIssues({ summary: "x".repeat(2000) })).toEqual([]);
    });

    it.each([
      ["empty", ""],
      ["blank", "   \n"],
      ["2001 characters", "x".repeat(2001)],
      ["not a string", 7],
      ["an object", { text: "x" }],
    ])("refuses a summary that is %s", (_label, summary) => {
      const issues = escalateIssues({ summary });
      expect(shape(issues)).toEqual(["field_value:summary"]);
      expect(issues[0]?.message).toContain("2000");
    });

    it("a ref in the summary to a node that does not exist is a ref_target issue", () => {
      expect(shape(escalateIssues({ summary: "see ${ghost.note}" }))).toEqual(["ref_target:null"]);
    });
  });

  // A VALID value for each knob (a `tier` outside small/medium/big would add a second issue of
  // its own), so what is refused is the field, and only the field.
  it.each([
    ["model", "some-model"],
    ["tier", "big"],
    ["effort", "low"],
    ["provider", "some-provider"],
  ])(
    "a routing knob (%s) is refused: the node spawns nothing, so there is nothing to route",
    (knob, value) => {
      expect(shape(escalateIssues({ [knob]: value }))).toEqual([`unknown_field:${knob}`]);
    },
  );

  it("a default is refused: an escalation always waits for a person", () => {
    expect(shape(escalateIssues({ default: "yes" }))).toEqual(["unknown_field:default"]);
  });

  it("the refs in `when` and `summary` order the escalate after the nodes they read", () => {
    const early = review({ id: "alpha" });
    const workflow = spec([early, SCAN]);
    expect(topologicalOrder(workflow).map((node) => node.id)).toEqual(["scan", "alpha"]);
  });
});

describe("a false when lets the run go on (#981)", () => {
  it("returns {escalated:false} with no leaf, no cell and no fault of its own", async () => {
    const runtime = new ScriptedRuntime([{ risk: 2 }, "shipped"]);
    const cache = new RecordingCache();
    const result = await run(runtime, chain(), ARGS, { cache });
    expect(result.outputs.review).toEqual({ escalated: false });
    expect(Object.isFrozen(result.outputs.review)).toBe(true);
    expect(runtime.spawned.map((request) => request.prompt)).toEqual(["Scan hello", "Ship hello"]);
    expect(cache.of("review")).toEqual({ gets: [], puts: [] });
    expect(result.status).toBe("complete");
    expect(result.faults).toEqual([]);
    expect(result.pauseReason).toBeNull();
    expect(result.outputs.ship).toBe("shipped");
  });

  it("a field the root lacks is a value that does not hold, never a fault", async () => {
    const runtime = new ScriptedRuntime([{ other: 1 }, "shipped"]);
    const result = await run(runtime, chain(), ARGS);
    expect(result.outputs.review).toEqual({ escalated: false });
    expect(result.faults).toEqual([]);
    expect(result.status).toBe("complete");
  });

  it("reads the arguments of the run too", async () => {
    const workflow = spec([
      review({ when: { field_true: { path: "${args.flag}" } }, summary: "x" }),
    ]);
    const off = await run(new ScriptedRuntime(), workflow, { flag: false });
    expect(off.outputs.review).toEqual({ escalated: false });
    expect(off.status).toBe("complete");
    const on = await run(new ScriptedRuntime(), workflow, { flag: true });
    expect(on.status).toBe("paused");
  });
});

describe("a true when without an answer pauses the run as escalated (#981)", () => {
  it("ends paused, with the payload {node_id, kind, summary}, and nothing after the node runs", async () => {
    const runtime = new ScriptedRuntime([{ risk: 9 }, "shipped"]);
    const result = await run(runtime, chain(), ARGS);
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("escalated");
    expect(result.checkpoint).toEqual({ node_id: "review", kind: "high_risk", summary: SUMMARY });
    expect(Object.isFrozen(result.checkpoint)).toBe(true);
    expect(result.outputs.review).toBeNull();
    expect(Object.hasOwn(result.outputs, "ship")).toBe(false);
    expect(runtime.spawned).toHaveLength(1);
  });

  it("names the pause in a fault that carries the node, and writes no cell", async () => {
    const cache = new RecordingCache();
    const result = await run(new ScriptedRuntime([{ risk: 9 }]), chain(), ARGS, { cache });
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]).toMatch(/^review: .*escalat/u);
    expect(cache.of("review").puts).toEqual([]);
  });

  it("spends no leaf of its own: the only spawn is the scan", async () => {
    const runtime = new ScriptedRuntime([{ risk: 9 }]);
    const result = await run(runtime, chain(), ARGS);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.capTrips).toBe(0);
  });

  it("renders a ref that is not text with the same form a prompt would show", async () => {
    const workflow = spec([SCAN, review({ summary: "${scan.risk}" })]);
    const result = await run(new ScriptedRuntime([{ risk: 9 }]), workflow, ARGS);
    expect(result.checkpoint).toMatchObject({ summary: "9" });
  });
});

describe("an answer resumes it, once (#981)", () => {
  const OUTPUT = { escalated: true, kind: "high_risk", summary: SUMMARY, answer: "approved" };

  it("turns checkpoint_answers[node_id] into {escalated:true, kind, summary, answer}", async () => {
    const runtime = new ScriptedRuntime([{ risk: 9 }, "shipped"]);
    const result = await run(runtime, chain(), ARGS, { answers: { review: "approved" } });
    expect(result.outputs.review).toEqual(OUTPUT);
    expect(Object.isFrozen(result.outputs.review)).toBe(true);
    expect(result.status).toBe("complete");
    expect(result.faults).toEqual([]);
    expect(result.outputs.ship).toBe("shipped");
    expect(runtime.spawned).toHaveLength(2);
  });

  it("caches the output under the node, in a cell with a pinned identity", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([{ risk: 9 }, "shipped"]), chain(), ARGS, {
      cache,
      answers: { review: "approved" },
    });
    const { puts } = cache.of("review");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.output).toEqual(OUTPUT);
    expect(puts[0]?.hash).toBe(contentHash(NAME, null, "review", "escalate", "high_risk", SUMMARY));
  });

  it.each([
    ["an empty string", ""],
    ["zero", 0],
    ["false", false],
    ["null", null],
    ["an object", { approve: true, note: "ok" }],
    ["a list", ["a", "b"]],
  ])("keeps %s as the answer — it is still an answer", async (_label, answer) => {
    const cache = new RecordingCache();
    const result = await run(new ScriptedRuntime([{ risk: 9 }, "shipped"]), chain(), ARGS, {
      cache,
      answers: { review: answer },
    });
    expect(result.outputs.review).toEqual({ ...OUTPUT, answer });
    expect(result.status).toBe("complete");
    expect(cache.of("review").puts).toHaveLength(1);
  });

  it("a resume after the pause keeps the finished nodes and spends only what is left", async () => {
    const cache = new RecordingCache();
    const first = new ScriptedRuntime([{ risk: 9 }, "shipped"]);
    const paused = await run(first, chain(), ARGS, { cache });
    expect(paused.status).toBe("paused");

    const second = new ScriptedRuntime(["shipped"]);
    const done = await run(second, chain(), ARGS, { cache, answers: { review: "approved" } });
    expect(done.status).toBe("complete");
    expect(second.spawned.map((request) => request.prompt)).toEqual(["Ship hello"]);
    expect(done.outputs.review).toEqual(OUTPUT);
  });

  it("never asks again: the cell answers a later run, whatever it is given", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([{ risk: 9 }, "shipped"]), chain(), ARGS, {
      cache,
      answers: { review: "approved" },
    });

    const replay = new ScriptedRuntime();
    const again = await run(replay, chain(), ARGS, { cache });
    expect(again.status).toBe("complete");
    expect(again.outputs.review).toEqual(OUTPUT);
    expect(replay.spawned).toEqual([]);

    const other = await run(new ScriptedRuntime(), chain(), ARGS, {
      cache,
      answers: { review: "rejected" },
    });
    expect(other.outputs.review).toEqual(OUTPUT);
  });

  it("a different summary is a different question: it asks again", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([{ risk: 9 }, "shipped"]), chain(), ARGS, {
      cache,
      answers: { review: "approved" },
    });
    const again = await run(
      new ScriptedRuntime([{ risk: 9 }]),
      chain(),
      { text: "other" },
      { cache },
    );
    expect(again.status).toBe("paused");
    expect(again.checkpoint).toMatchObject({ summary: "Risk 9 on other" });
  });

  it("a different kind is a different question too", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([{ risk: 9 }, "shipped"]), chain(), ARGS, {
      cache,
      answers: { review: "approved" },
    });
    const again = await run(new ScriptedRuntime(), chain({ kind: "legal" }), ARGS, { cache });
    expect(again.status).toBe("paused");
    expect(again.checkpoint).toMatchObject({ kind: "legal" });
  });

  it("when is read again on every run: a condition that stopped holding does not ask", async () => {
    const workflow = spec([
      review({ when: { field_true: { path: "${args.flag}" } }, summary: "flagged" }),
    ]);
    const cache = new RecordingCache();
    const answered = await run(
      new ScriptedRuntime(),
      workflow,
      { flag: true },
      {
        cache,
        answers: { review: "ok" },
      },
    );
    expect(answered.outputs.review).toMatchObject({ escalated: true, answer: "ok" });
    const later = await run(new ScriptedRuntime(), workflow, { flag: false }, { cache });
    expect(later.outputs.review).toEqual({ escalated: false });
    expect(later.status).toBe("complete");
  });
});

// The node exists to put a person in front of a decision, so no failure of its own may skip the
// person: whatever cannot be read pauses the run, says what could not be read, and leaves the
// nodes that depend on it unspawned.
describe("a failure never skips the person (#981, round 2)", () => {
  const MISSING = "Risk ${scan.risk}: ${scan.reason}";
  const shipped = (runtime: ScriptedRuntime): boolean =>
    runtime.spawned.some((request) => request.prompt === "Ship hello");

  it("a summary that reads a value that is not there pauses with the template, marked, and names the ref", async () => {
    const runtime = new ScriptedRuntime([{ risk: 9 }, "shipped"]);
    const cache = new RecordingCache();
    const result = await run(runtime, chain({ summary: MISSING }), ARGS, { cache });
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("escalated");
    expect(result.checkpoint).toEqual({
      node_id: "review",
      kind: "high_risk",
      summary: `[unrendered] ${MISSING}`,
    });
    expect(result.outputs.review).toBeNull();
    expect(shipped(runtime)).toBe(false);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]).toMatch(/^review: escalated for review/u);
    expect(result.faults[0]).toContain("no value for ${scan.reason}");
    expect(result.faults[0]).not.toContain("${scan.risk}");
    expect(result.faults[0]).not.toContain("upstream null");
    expect(cache.of("review").puts).toEqual([]);
  });

  it.each([
    ["a field the scan did not give", { risk: 9 }],
    ["a field the scan gave as null", { risk: 9, reason: null }],
  ])("%s is the same: the person is asked, never skipped", async (_label, scan) => {
    const runtime = new ScriptedRuntime([scan, "shipped"]);
    const result = await run(runtime, chain({ summary: MISSING }), ARGS);
    expect(result.status).toBe("paused");
    expect((result.checkpoint as { summary: string }).summary).toBe(`[unrendered] ${MISSING}`);
    expect(shipped(runtime)).toBe(false);
  });

  it("names every ref that is missing, once each", async () => {
    const summary = "${scan.a} then ${scan.b} and again ${scan.a}";
    const result = await run(new ScriptedRuntime([{ risk: 9 }]), chain({ summary }), ARGS);
    // At the END of the fault: a repeated ${scan.a} would follow it.
    expect(result.faults[0]).toMatch(/no value for \$\{scan\.a\}, \$\{scan\.b\}$/u);
  });

  it("the answer resumes it: the output keeps the marked template, and the dependents run", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([{ risk: 9 }]), chain({ summary: MISSING }), ARGS, { cache });
    const second = new ScriptedRuntime(["shipped"]);
    const done = await run(second, chain({ summary: MISSING }), ARGS, {
      cache,
      answers: { review: "go" },
    });
    expect(done.status).toBe("complete");
    expect(done.faults).toEqual([]);
    expect(done.outputs.review).toEqual({
      escalated: true,
      kind: "high_risk",
      summary: `[unrendered] ${MISSING}`,
      answer: "go",
    });
    expect(second.spawned.map((request) => request.prompt)).toEqual(["Ship hello"]);
  });

  it("a ref a prompt would render — an array index, a field of a JSON string — is not missing", async () => {
    const scan = { risk: 9, items: ["alpha"], note: '{"a":"beta"}' };
    const summary = "${scan.items.0} ${scan.note.a}";
    const result = await run(new ScriptedRuntime([scan]), chain({ summary }), ARGS);
    expect(result.status).toBe("paused");
    expect(result.checkpoint).toMatchObject({ summary: "alpha beta" });
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]).not.toContain("summary not rendered");
  });

  it.each([
    ["an empty string", "${scan.note}", ""],
    ["blank text around an empty string", "  ${scan.note}  ", ""],
    ["whitespace only", "${scan.note}", " \n\t"],
  ])(
    "a summary that renders as %s pauses with the template, marked, and says it is empty",
    async (_label, summary, note) => {
      const runtime = new ScriptedRuntime([{ risk: 9, note }, "shipped"]);
      const result = await run(runtime, chain({ summary }), ARGS);
      expect(result.status).toBe("paused");
      expect(result.pauseReason).toBe("escalated");
      expect(result.checkpoint).toEqual({
        node_id: "review",
        kind: "high_risk",
        summary: `[empty summary] ${summary}`,
      });
      expect(result.faults[0]).toContain("summary rendered empty");
      expect(shipped(runtime)).toBe(false);
    },
  );

  it("a `when` that reads a dead node is held to be true: the run pauses, the summary and the faults say why", async () => {
    const runtime = new ScriptedRuntime([DEAD, DEAD, "shipped"]);
    const cache = new RecordingCache();
    const result = await run(runtime, chain(), ARGS, { cache });
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("escalated");
    expect(result.checkpoint).toEqual({
      node_id: "review",
      kind: "high_risk",
      summary:
        "[condition not evaluated: 'scan' has no value] [unrendered] Risk ${scan.risk} on ${args.text}",
    });
    expect(result.outputs.review).toBeNull();
    expect(shipped(runtime)).toBe(false);
    expect(result.faults).toContain("review: upstream null");
    expect(
      result.faults.some((fault) =>
        /^review: escalated for review \(high_risk\) .*'when' could not be evaluated: 'scan' has no value \(upstream null\)/u.test(
          fault,
        ),
      ),
    ).toBe(true);
    expect(cache.of("review").puts).toEqual([]);
  });

  it("…and a person can still answer it: same marked summary, and the dependents run", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([DEAD, DEAD]), chain(), ARGS, { cache });
    const second = new ScriptedRuntime([DEAD, DEAD, "shipped"]);
    const done = await run(second, chain(), ARGS, { cache, answers: { review: "go" } });
    expect(done.pauseReason).toBeNull();
    expect(done.outputs.review).toEqual({
      escalated: true,
      kind: "high_risk",
      summary:
        "[condition not evaluated: 'scan' has no value] [unrendered] Risk ${scan.risk} on ${args.text}",
      answer: "go",
    });
    expect(shipped(second)).toBe(true);
  });

  it("a name the run does not have (a fan-out's ${item} at the top level) is 'no value' too", async () => {
    const workflow = spec([
      review({ when: { field_true: { path: "${item.ok}" } }, summary: "no item here" }),
    ]);
    const result = await run(new ScriptedRuntime(), workflow, ARGS);
    expect(result.status).toBe("paused");
    expect(result.checkpoint).toMatchObject({
      summary: "[condition not evaluated: 'item' has no value] no item here",
    });
    expect(result.faults).toContain("review: upstream null");
  });

  it("a root that is there but lacks the field is only a value: the condition does not hold, the run goes on", async () => {
    const result = await run(new ScriptedRuntime([{ other: 1 }, "shipped"]), chain(), ARGS);
    expect(result.outputs.review).toEqual({ escalated: false });
    expect(result.status).toBe("complete");
  });

  it("a summary longer than 2000 characters once its refs are filled is cut, with a visible ellipsis", async () => {
    const workflow = spec([
      review({ when: { field_true: { path: "${args.flag}" } }, summary: "${args.long}" }),
    ]);
    const long = "x".repeat(3000);
    const paused = await run(new ScriptedRuntime(), workflow, { flag: true, long });
    const summary = (paused.checkpoint as { summary: string }).summary;
    expect(summary).toHaveLength(MAX_ESCALATE_SUMMARY);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.startsWith("xxxx")).toBe(true);

    const answered = await run(
      new ScriptedRuntime(),
      workflow,
      { flag: true, long },
      {
        answers: { review: "ok" },
      },
    );
    expect((answered.outputs.review as { summary: string }).summary).toBe(summary);
  });

  it("a cut that would split an emoji drops the orphaned half instead of keeping it", async () => {
    const workflow = spec([
      review({ when: { field_true: { path: "${args.flag}" } }, summary: "${args.long}" }),
    ]);
    const long = `${"z".repeat(1998)}😀${"z".repeat(50)}`;
    const paused = await run(new ScriptedRuntime(), workflow, { flag: true, long });
    expect((paused.checkpoint as { summary: string }).summary).toBe(`${"z".repeat(1998)}…`);
  });

  it("a summary of exactly 2000 characters is kept whole", async () => {
    const workflow = spec([
      review({ when: { field_true: { path: "${args.flag}" } }, summary: "${args.long}" }),
    ]);
    const long = "y".repeat(2000);
    const paused = await run(new ScriptedRuntime(), workflow, { flag: true, long });
    expect((paused.checkpoint as { summary: string }).summary).toBe(long);
  });
});
