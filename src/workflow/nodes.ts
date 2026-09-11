export const MAX_STATIC_FANOUT = 64;
export const MAX_NODE_RETRIES = 3;
export const MAX_GATE_ATTEMPTS = 3;
export const MAX_NODE_MAX_ITERATIONS = 128;

const COMMON = ["required", "depends_on"] as const;
export const ROUTING_FIELDS = ["model", "tier", "effort", "provider"] as const;

/**
 * The agent-shaped field set every schema-bearing sub-object may carry
 * (`gate.body`, `loop_until_dry.body`, `judge_panel.synthesize`,
 * `parallel.branches[*]` when a branch is an object) — shared by
 * `schema.ts`'s `validateSubObjectFields`/`validateSubObjectValues` and the
 * anti-drift test so the two never drift apart. A routing knob
 * (`model`/`tier`/`effort`/`provider`) does not belong here — but the reason
 * is no longer uniform since #342: `runGate`/`runLoop` (`engine.ts`) now
 * merge `body` onto the node before spawning (`mergeBodyIntoNode`,
 * `leaf-options.ts`), so a routing knob in `body` would actually be read if
 * this list allowed it — refusing it is a spec-design decision (only a
 * `stages[*]` entry gets its own routing), not a mechanical dead field.
 * `judge_panel.synthesize` and `parallel.branches[*]` still spawn with the
 * OUTER node unmodified (`runJudgePanel`/`runParallel` pass `node`, never the
 * sub-object, to `collectLeaf`), so routing there really has no reader.
 */
export const SUB_OBJECT_FIELDS = [
  "prompt",
  "schema",
  "schema_ref",
  "tool_less",
  "timeout",
  "retries",
  "max_iterations",
] as const;

/**
 * `pipeline.stages[*]` is the one schema-bearing sub-object that DOES spawn
 * its own leaf: `runPipeline` (`engine.ts`) merges the stage onto the node
 * (`new Node(node.id, node.type, { ...node.fields, ...stage })`) before
 * `routingIdentity`/`collectLeaf`, so a stage's own `model`/`tier`/`effort`/
 * `provider` is read and overrides the node's for that stage's leaf — round
 * 1 of #238 refused it as dead, which was wrong (PR #341 review).
 */
export const STAGE_FIELDS = [...SUB_OBJECT_FIELDS, ...ROUTING_FIELDS] as const;

export interface NodeSpec {
  readonly fields: readonly string[];
  readonly required: readonly string[];
}

const spec = (fields: readonly string[], required: readonly string[], routing = false): NodeSpec =>
  Object.freeze({
    fields: Object.freeze([...COMMON, ...(routing ? ROUTING_FIELDS : []), ...fields]),
    required: Object.freeze([...required]),
  });

export const NODE_SPECS: Readonly<Record<string, NodeSpec>> = Object.freeze({
  agent: spec(
    ["prompt", "schema", "schema_ref", "tool_less", "timeout", "retries", "max_iterations"],
    ["prompt"],
    true,
  ),
  parallel: spec(["branches", "retries"], ["branches"]),
  pipeline: spec(["items", "stages", "min_success_ratio"], ["items", "stages"]),
  loop_until_dry: spec(
    ["body", "stop_after_k_empty", "max_rounds", "budget"],
    ["body", "stop_after_k_empty", "max_rounds"],
    true,
  ),
  verify: spec(
    ["finding", "skeptics", "lenses", "kill_if_majority_refute"],
    ["finding", "skeptics"],
    true,
  ),
  judge_panel: spec(
    ["attempts", "judges", "synthesize"],
    ["attempts", "judges", "synthesize"],
    true,
  ),
  workflow: spec(["ref", "args"], ["ref"]),
  gate: spec(["body", "validator", "attempts"], ["body", "validator"], true),
  completeness_check: spec(["task", "results"], ["task", "results"], true),
  checkpoint: spec(["prompt", "default"], ["prompt"]),
});

export const NODE_TYPES: ReadonlySet<string> = new Set(Object.keys(NODE_SPECS));
