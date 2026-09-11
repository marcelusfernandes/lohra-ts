import type { RunResult } from "./accounting.js";
import type { LeafExecution, RunControl } from "./engine-contract.js";
import { clampInteger, loopCellParts, routingIdentity, stoppedByControl } from "./engine-utils.js";
import { MAX_NODE_RETRIES } from "./nodes.js";
import type { TierMap } from "./tiers.js";
import { Node } from "./types.js";

/**
 * Issue #342: `gate.body` and `loop_until_dry.body` validate the same
 * agent-shaped fields `pipeline.stages[*]` does (`SUB_OBJECT_FIELDS`,
 * `nodes.ts`) — `tool_less`/`timeout`/`retries`/`max_iterations` — but
 * `runGate`/`runLoop` (`engine.ts`) used to pass the OUTER node straight to
 * `collectLeaf`, so none of `body`'s own knobs was ever read: `collectLeaf`
 * resolves `timeout`/`tool_less`/`max_iterations` off `node.fields`, and
 * `body` lives one level down, at `node.fields.body`. `runPipeline` already
 * solved the same problem for `stages[*]` by building a merged `Node` before
 * spawning (`new Node(node.id, node.type, { ...node.fields, ...stage })`) —
 * this mirrors that same merge for `gate`/`loop_until_dry`, kept in its own
 * module (not inlined a second time into `engine.ts`, which is frozen at its
 * base line count — 987 — by the CI `arquivo-grande` contract's no-growth
 * rule, `scripts/ci/contratos/lib.ts`) so both call sites share one merge
 * instead of two near-identical inline copies.
 */
export function mergeBodyIntoNode(node: Node, body: Readonly<Record<string, unknown>>): Node {
  return new Node(node.id, node.type, { ...node.fields, ...body });
}

/** Fixed, deterministic order for the four knobs `mergeBodyIntoNode` reads —
 * shared by `bodyKnobCellParts` below so "which knobs are present" always
 * folds into a cache cell the same way regardless of the object's own key
 * insertion order in the parsed spec. */
const BODY_KNOB_FIELDS = ["tool_less", "timeout", "retries", "max_iterations"] as const;

/**
 * The extra cell-identity parts `gate`/`loop_until_dry` must fold in so a
 * different `body` knob is a different cache cell (PR #341 review's own
 * reasoning for folding `loop_until_dry.budget` into `loopCellParts`,
 * `engine-utils.ts`, applies here too) — key AND value per knob, in the
 * fixed `BODY_KNOB_FIELDS` order, so `{timeout: 3}` and `{retries: 3}` never
 * collide on the bare value `3` alone. Only knobs the spec actually SETS are
 * folded in (`Object.hasOwn`, not a plain lookup — `undefined` would still
 * add elements and change the hash for every `body` that never mentions the
 * knob at all): a `body` with only `prompt` — today's only knob with a
 * reader before this issue — folds in nothing, so the hash for that shape is
 * byte-identical to the pre-#342 one (durable resume compatible).
 */
export function bodyKnobCellParts(body: Readonly<Record<string, unknown>>): readonly unknown[] {
  const parts: unknown[] = [];
  for (const key of BODY_KNOB_FIELDS) {
    if (Object.hasOwn(body, key)) parts.push(key, body[key]);
  }
  return parts;
}

/**
 * `runGate`'s full cell-identity array, element order UNCHANGED from before
 * #342 with `bodyKnobCellParts(body)` appended — a `body` with only `prompt`
 * (today's only knob with a reader before this issue) appends nothing, so
 * the hash for that shape is byte-identical to the pre-#342 one. Lives here,
 * not inline in `engine.ts` (frozen at 987 lines, see `mergeBodyIntoNode`'s
 * own comment above), alongside the merge/retry logic it identifies.
 */
export function gateCellParts(
  node: Node,
  tiers: TierMap,
  prompt: unknown,
  schema: Readonly<Record<string, unknown>> | null,
  validator: unknown,
  attempts: number,
  body: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  return [
    node.id,
    "gate",
    prompt,
    schema,
    validator,
    attempts,
    ...routingIdentity(node, tiers),
    ...bodyKnobCellParts(body),
  ];
}

/** `runLoop`'s full cell-identity array — `loopCellParts` (`engine-utils.ts`)
 * unchanged, with `bodyKnobCellParts(body)` appended for the same
 * byte-compat reason `gateCellParts` above documents. */
export function loopBodyCellParts(
  node: Node,
  tiers: TierMap,
  firstPrompt: unknown,
  bodySchema: unknown,
  stopAfter: number,
  rounds: number,
  body: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  return [
    ...loopCellParts(node, tiers, firstPrompt, bodySchema, stopAfter, rounds),
    ...bodyKnobCellParts(body),
  ];
}

/** What `makeBodyLeafRunner` needs from the engine — `collectLeaf` bound by the
 * caller so `this` stays correct (same pattern `ParallelBranchDeps` already
 * uses in `engine-utils.ts`), `control` to stop a retry loop once the run
 * itself is known to be stopping, and `result` so a respawn credits the SAME
 * `leafRespawns` counter every other respawn path in this engine credits. */
export interface BodyLeafDeps {
  readonly control: RunControl;
  readonly result: RunResult;
  readonly collectLeaf: (
    node: Node,
    prompt: string,
    schema: Readonly<Record<string, unknown>> | null,
    options: { readonly role: string; readonly cellId: string; readonly attempt?: number },
  ) => Promise<LeafExecution>;
}

/** The one leaf spawn `runGate`/`runLoop` hand to each attempt/round, once
 * `node`/`body` are merged (`makeBodyLeafRunner` below builds this). */
export type BodyLeafRunner = (
  prompt: string,
  schema: Readonly<Record<string, unknown>> | null,
  options: { readonly role: string; readonly cellId: string; readonly attempt?: number },
) => Promise<LeafExecution>;

/**
 * Builds `gate.body`/`loop_until_dry.body`'s leaf spawner ONCE per node run
 * (`runGate`/`runLoop` call this before their attempt/round loop, not inside
 * it): `body`'s own `tool_less`/`timeout`/`max_iterations` merged onto the
 * node every spawn uses (`mergeBodyIntoNode`), and `body.retries` (0-3,
 * default 0 — absent means today's behavior, exactly `parallel.retries`'s
 * own default/range) respawning a DEAD leaf (`output === null`) up to that
 * many times on every call the returned runner makes.
 *
 * Only a DEAD leaf is retried, never a legitimate EMPTY one — the same
 * distinction `collectBranchWithRetries` (`engine-utils.ts`) draws for a
 * `parallel` branch. That distinction matters even more here: `runLoop`
 * already treats an empty round as the dry signal it is watching FOR
 * (`isDryRound`, counted against `stop_after_k_empty`) — retrying an empty
 * round here as if it were a failure would fight that signal instead of
 * leaving it alone. `stoppedByControl` (`engine-utils.ts`) is the same guard
 * every other retry loop in this codebase already checks, so a run that is
 * itself stopping (budget/quota/cancel/pause) never spins through a full
 * `retries` count doing nothing. A respawn reuses the SAME `options.attempt`
 * the caller passed in (unlike `collectBranchWithRetries`, which bumps it
 * per respawn for causal tracing) — the outer attempt/round index is what
 * identifies the causal step here; the inner respawn count is not.
 */
export function makeBodyLeafRunner(
  deps: BodyLeafDeps,
  node: Node,
  body: Readonly<Record<string, unknown>>,
): BodyLeafRunner {
  const effective = mergeBodyIntoNode(node, body);
  const retries = clampInteger(body.retries, 0, MAX_NODE_RETRIES);
  return async (prompt, schema, options) => {
    let leaf = await deps.collectLeaf(effective, prompt, schema, options);
    for (
      let attempt = 1;
      attempt <= retries && leaf.output === null && !stoppedByControl(deps.control);
      attempt += 1
    ) {
      deps.result.leafRespawns += 1;
      leaf = await deps.collectLeaf(effective, prompt, schema, options);
    }
    return leaf;
  };
}
