#!/usr/bin/env node
import process from "node:process";

import {
  Budget,
  MemoryWorkflowCache,
  parseAndValidate,
  WorkflowEngine,
  validateSpec,
} from "../../../dist/workflow/index.js";

const split = {
  inputTokens: 5,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

class RulesRuntime {
  constructor(fail = "") {
    this.fail = fail;
    this.requests = [];
    this.steers = [];
    this.byId = new Map();
  }
  spawn(request) {
    const id = `leaf-${String(this.requests.length + 1)}`;
    this.requests.push(request);
    this.byId.set(id, 0);
    return id;
  }
  collect(id) {
    const request = this.requests[Number(id.split("-")[1]) - 1];
    const count = this.byId.get(id) ?? 0;
    this.byId.set(id, count + 1);
    const role = request.causalContext.role;
    if (this.fail === role || this.fail === "all")
      return { status: "failed", output: `dead:${role}` };
    if (this.fail === "schema" && role === "agent" && count === 0)
      return { status: "complete", output: '{"wrong":true}', usage: split };
    let output = "ok";
    if (this.fail === "verify-invalid" && role === "verify.skeptic") output = { unexpected: true };
    else if (role === "verify.skeptic") output = { refuted: false, reason: "ok" };
    else if (role === "judge.attempt") output = this.fail === "judge-winner" ? "BEST-CANDIDATE" : "draft";
    else if (this.fail === "judge-invalid" && role === "judge.review") output = '{"unexpected":true}';
    else if (role === "judge.review") output = '{"score":9,"rationale":"ok"}';
    else if (role === "judge.synthesis") output = "final";
    else if (role === "loop.round") output = request.prompt.includes("harvest 0") ? "item" : "";
    else if (role === "gate.body") output = "draft";
    else if (this.fail === "gate-invalid" && role === "gate.reviewer") output = '{"unexpected":true}';
    else if (role === "gate.reviewer") output = '{"ok":true,"feedback":""}';
    else if (role === "completeness") output = { complete: true, missing: [] };
    else if (this.fail === "schema" && role === "agent") output = { value: 1 };
    const usage = this.fail === "schema" && role === "agent" && count > 0
      ? { ...split, inputTokens: 10, outputTokens: 6 }
      : split;
    return { status: "complete", output, usage, provider: "stub", model: "canned" };
  }
  steer(id, prompt) { this.steers.push({ id, prompt }); }
  cancel() {}
}

function spec(raw) {
  const value = validateSpec(raw);
  if ("issues" in value) throw new Error(value.message);
  return value;
}

const child = {
  meta: { name: "child", version: 1 },
  nodes: [{ id: "inner", type: "agent", prompt: "nested" }],
};

const successSpecs = {
  agent: { meta: { name: "agent" }, nodes: [{ id: "n", type: "agent", prompt: "answer" }] },
  parallel: { meta: { name: "parallel" }, nodes: [{ id: "n", type: "parallel", branches: ["a", "b"] }] },
  pipeline: { meta: { name: "pipeline" }, nodes: [{ id: "n", type: "pipeline", items: ["a", "b"], stages: [{ prompt: "pipe ${item}" }] }] },
  verify: { meta: { name: "verify" }, nodes: [{ id: "n", type: "verify", finding: "claim", skeptics: 1, kill_if_majority_refute: true }] },
  judge_panel: { meta: { name: "judge" }, nodes: [{ id: "n", type: "judge_panel", attempts: ["attempt"], judges: 1, synthesize: { prompt: "polish ${winner}" } }] },
  loop_until_dry: { meta: { name: "loop" }, nodes: [{ id: "n", type: "loop_until_dry", body: { prompt: "harvest ${round}" }, stop_after_k_empty: 1, max_rounds: 3 }] },
  workflow: { meta: { name: "workflow" }, nodes: [{ id: "n", type: "workflow", ref: "child" }] },
  gate: { meta: { name: "gate" }, nodes: [{ id: "n", type: "gate", body: { prompt: "draft" }, validator: "approve", attempts: 1 }] },
  completeness_check: { meta: { name: "completeness" }, nodes: [{ id: "n", type: "completeness_check", task: "task", results: ["result"] }] },
  checkpoint: { meta: { name: "checkpoint" }, nodes: [{ id: "n", type: "checkpoint", prompt: "approve?" }] },
};

function project(result, runtime) {
  return {
    status: result.status,
    outputs: result.outputs,
    faults: result.faults.length,
    nullCount: result.nullCount,
    engineFaults: result.engineFaults,
    capTrips: result.capTrips,
    validationRetries: result.validationRetries,
    nodesTotal: result.nodesTotal,
    tokens: [result.tokensIn, result.tokensOut, result.cacheReadTokens, result.cacheWriteTokens, result.reasoningTokens],
    spawns: runtime.requests.length,
  };
}

async function runOne(raw, options = {}) {
  const runtime = new RulesRuntime(options.fail ?? "");
  const engine = new WorkflowEngine({
    runtime,
    ...(options.budget ? { budget: options.budget } : {}),
    loader: async (reference) => (reference === "child" ? child : null),
    checkpointAnswers: options.answers ?? {},
  });
  return { value: project(await engine.run(spec(raw), options.args ?? {}), runtime), runtime, engine };
}

const successes = {};
for (const [name, raw] of Object.entries(successSpecs)) {
  const { value } = await runOne(raw, name === "checkpoint" ? { answers: { n: false } } : {});
  successes[name] = value;
}

const failureRoles = {
  agent: "agent",
  parallel: "parallel.branch",
  pipeline: "pipeline.stage",
  verify: "verify.skeptic",
  judge_panel: "judge.attempt",
  loop_until_dry: "loop.round",
  gate: "gate.body",
  completeness_check: "completeness",
};
const failures = {};
for (const [name, role] of Object.entries(failureRoles)) {
  failures[name] = (await runOne(successSpecs[name], { fail: role })).value;
}
failures.checkpoint = (await runOne(successSpecs.checkpoint)).value;

const deep = { meta: { name: "deep" }, nodes: [{ id: "deep", type: "workflow", ref: "child" }] };
const depthRuntime = new RulesRuntime();
const depthEngine = new WorkflowEngine({
  runtime: depthRuntime,
  loader: async (reference) => (reference === "child" ? deep : null),
});
failures.workflow = project(await depthEngine.run(spec(successSpecs.workflow)), depthRuntime);

const fanout = await runOne(
  { meta: { name: "fanout" }, nodes: [{ id: "n", type: "parallel", branches: "${args.items}" }] },
  { args: { items: ["a", "b"] }, budget: new Budget({ maxFanout: 1 }) },
);
const budget = await runOne(
  { meta: { name: "budget" }, nodes: [{ id: "a", type: "agent", prompt: "a" }, { id: "b", type: "agent", prompt: "b" }] },
  { budget: new Budget({ tokenBudget: 7 }) },
);
const schemaRetry = await runOne(
  { meta: { name: "schema" }, nodes: [{ id: "n", type: "agent", prompt: "x", schema: { type: "object", required: ["value"] } }] },
  { fail: "schema" },
);

const nullRuntime = new RulesRuntime("agent");
const nullResult = await new WorkflowEngine({ runtime: nullRuntime }).run(
  spec({ meta: { name: "null-upstream" }, nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }, { id: "b", type: "agent", prompt: "${a}" }] }),
);

const faultRuntime = new RulesRuntime();
const faultEngine = new WorkflowEngine({ runtime: faultRuntime });
faultEngine.setStrategyForTest("agent", (_engine, node) =>
  node.id === "bad" ? Promise.reject(new TypeError("boom")) : Promise.resolve("ok"),
);
const engineFault = project(
  await faultEngine.run(spec({ meta: { name: "engine-fault" }, nodes: [{ id: "bad", type: "agent", prompt: "x" }, { id: "good", type: "agent", prompt: "y" }] })),
  faultRuntime,
);

const cacheRuntime = new RulesRuntime();
const cache = new MemoryWorkflowCache();
const base = spec({ meta: { name: "cache" }, nodes: [{ id: "n", type: "agent", prompt: "x" }] });
const changed = spec({ meta: { name: "cache" }, nodes: [{ id: "n", type: "agent", prompt: "y" }] });
await new WorkflowEngine({ runtime: cacheRuntime, cache, runId: "same" }).run(base);
await new WorkflowEngine({ runtime: cacheRuntime, cache, runId: "same" }).run(base);
await new WorkflowEngine({ runtime: cacheRuntime, cache, runId: "same" }).run(changed);

const pipelinePreflight = await runOne(
  { meta: { name: "pipeline-preflight" }, nodes: [{ id: "n", type: "pipeline", items: ["a", "b", "c"], stages: [{ prompt: "pipe ${item}" }] }] },
  { budget: new Budget({ maxFanout: 2 }) },
);
const schemaKeywords = [
  ["0", { type: "number", minimum: 1 }],
  ['{"extra":1}', { type: "object", additionalProperties: false }],
  [JSON.stringify("abc"), { type: "string", pattern: "^z" }],
  ["[]", { type: "array", minItems: 1 }],
  ["1", { oneOf: [{ type: "number" }, { const: 1 }] }],
  ['{"a":1}', { type: "object", dependentSchemas: { a: { required: ["b"] } } }],
  ['{"BAD":1}', { type: "object", propertyNames: { pattern: "^[a-z]+$" } }],
  ['{"a":1,"b":2}', { type: "object", properties: { a: { type: "number" } }, unevaluatedProperties: false }],
].map(([output, schema]) => parseAndValidate(output, schema).ok);
const verifyInvalid = await runOne(
  { meta: { name: "verify-invalid" }, nodes: [{ id: "n", type: "verify", finding: "claim", skeptics: 1, lenses: ["SECURITY-LENS"], kill_if_majority_refute: true }] },
  { fail: "verify-invalid" },
);
const judgeWinner = await runOne(
  { meta: { name: "judge-winner" }, nodes: [{ id: "n", type: "judge_panel", attempts: ["attempt"], judges: 1, synthesize: { prompt: "polish this" } }] },
  { fail: "judge-winner" },
);
const gateSequential = await runOne(successSpecs.gate, { budget: new Budget({ tokenBudget: 100 }) });
const judgeInvalid = await runOne(
  { meta: { name: "judge-invalid" }, nodes: [{ id: "n", type: "judge_panel", attempts: ["attempt"], judges: 1, synthesize: null }] },
  { fail: "judge-invalid" },
);
const gateInvalid = await runOne(
  { meta: { name: "gate-invalid" }, nodes: [{ id: "n", type: "gate", body: { prompt: "draft" }, validator: "approve", attempts: 1 }] },
  { fail: "gate-invalid" },
);
const nanBudget = new Budget({ poolWidth: Number.NaN, maxFanout: Number.NaN, lifetime: Number.NaN });
const anchorSchema = { $defs: { p: { $anchor: "positive", type: "integer", minimum: 1 } }, $ref: "#positive" };
const dynamicSchema = { $defs: { p: { $dynamicAnchor: "node", type: "object" } }, $dynamicRef: "#node" };
const embeddedIdSchema = { $defs: { foo: { $id: "urn:example:foo", type: "integer" } }, $ref: "urn:example:foo" };
const pointerSchema = { $defs: { text: { type: "string" } }, $ref: "#/$defs/text" };
const referenceMatrix = {
  anchor: [parseAndValidate(2, anchorSchema).ok, parseAndValidate(0, anchorSchema).ok],
  dynamic: [parseAndValidate({}, dynamicSchema).ok, parseAndValidate([], dynamicSchema).ok],
  embeddedId: [parseAndValidate(2, embeddedIdSchema).ok, parseAndValidate(JSON.stringify("2"), embeddedIdSchema).ok],
  pointer: [parseAndValidate(JSON.stringify("ok"), pointerSchema).ok, parseAndValidate(2, pointerSchema).ok],
  unresolved: ["#missing", "urn:missing:no-network"].map(($ref) => parseAndValidate(2, { $ref }).ok),
};
const multipleOf = [0.2, 0.3, 0.6, 0.7, 1.5].map((value) => parseAndValidate(value, { type: "number", multipleOf: 0.1 }).ok);

process.stdout.write(`${JSON.stringify({ successes, failures, fanout: fanout.value, budget: budget.value, nullUpstream: project(nullResult, nullRuntime), engineFault, schemaRetry: schemaRetry.value, cache: { spawns: cacheRuntime.requests.length, split: cache.totalSplit("same") }, round1: { pipelinePreflight: pipelinePreflight.value, schemaKeywords, verifyInvalid: { output: verifyInvalid.value.outputs.n, steers: verifyInvalid.runtime.steers.length, lens: verifyInvalid.runtime.requests.some((request) => request.prompt.includes("SECURITY-LENS")) }, judgePrompt: judgeWinner.runtime.requests.find((request) => request.causalContext.role === "judge.synthesis")?.prompt ?? null, gateSequential: gateSequential.value, nanBudget: [nanBudget.poolWidth, nanBudget.maxFanout, nanBudget.lifetimeRemaining] }, round2: { judgeInvalid: { output: judgeInvalid.value.outputs.n, steers: judgeInvalid.runtime.steers.length, spawns: judgeInvalid.runtime.requests.length }, gateInvalid: { output: gateInvalid.value.outputs.n, steers: gateInvalid.runtime.steers.length, spawns: gateInvalid.runtime.requests.length } }, round3: { referenceMatrix, multipleOf } })}\n`);
