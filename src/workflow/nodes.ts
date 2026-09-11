export const MAX_STATIC_FANOUT = 64;
export const MAX_NODE_RETRIES = 3;
export const MAX_GATE_ATTEMPTS = 3;
export const MAX_NODE_MAX_ITERATIONS = 128;

const COMMON = ["required", "depends_on"] as const;
const ROUTING = ["model", "tier", "effort", "provider"] as const;

/**
 * The agent-shaped field set every schema-bearing sub-object may carry
 * (`gate.body`, `loop_until_dry.body`, `judge_panel.synthesize`,
 * `pipeline.stages[*]`, `parallel.branches[*]` when a branch is an object) —
 * shared by `schema.ts`'s `validateSubObjectFields` and the anti-drift test
 * so the two never drift apart. A routing knob (`model`/`tier`/`effort`/
 * `provider`) does not belong here: it goes on the node itself (#238).
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

export interface NodeSpec {
  readonly fields: readonly string[];
  readonly required: readonly string[];
}

const spec = (fields: readonly string[], required: readonly string[], routing = false): NodeSpec =>
  Object.freeze({
    fields: Object.freeze([...COMMON, ...(routing ? ROUTING : []), ...fields]),
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
