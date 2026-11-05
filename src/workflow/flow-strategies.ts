import type { Usage } from "../pricing/types.js";
import type { RunResult } from "./accounting.js";
import type { Budget } from "./budget.js";
import type { WorkflowCache } from "./cache.js";
import { CACHE_MISS, type LeafExecution, type RunControl } from "./engine-contract.js";
import {
  applyCheckpointAnswer,
  checkpointPausePayload,
  renderValue,
  resolveCheckpoint,
  routingIdentity,
  strictResolve,
} from "./engine-utils.js";
import type { CausalContext, ChildRuntime } from "./runtime.js";
import type { TierMap } from "./tiers.js";
import type { Node } from "./types.js";

/** What `collectLeaf` takes besides the node, the prompt and the schema. */
export interface LeafCollectOptions {
  readonly role: string;
  readonly cellId: string;
  readonly itemIndex?: number;
  readonly stageIndex?: number;
  readonly attempt?: number;
  readonly aborted?: () => boolean;
}

/**
 * Everything a node strategy outside `engine.ts` may touch — nothing else of the engine is
 * reachable, so a new node type (épico #976: `switch`, `loop`, `escalate`, `call`) is a new
 * file and one line in `FLOW_STRATEGIES`, never another method on a file past its size
 * limit. Built by `WorkflowEngine` once per node, frozen, and bound: destructuring is safe.
 *
 * - **Identity.** `runId`, `nodeScope` (empty at the root; the ancestor `workflow` node ids
 *   once nested) and `cell(parts)`, the content hash of the spec identity followed by
 *   `parts`. A strategy that changes what it passes to `cell` changes its cache cells.
 * - **Cells.** `cacheGet(hash)` is `CACHE_MISS` or the stored output (it also credits the
 *   cell's cost to the run); `cachePut` stores a non-empty output under the scoped node id;
 *   `cache` + `runId` are there for the one write `cachePut` cannot make — an answer that
 *   may be empty (`applyCheckpointAnswer`).
 * - **Leaves.** `collectLeaf` takes the pool, the token and fan-out gates and the sandbox;
 *   `causal` builds the context a runtime port needs; `schemaOf` resolves a `schema` or
 *   `schema_ref`; `tiers` is for `routingIdentity`; `runtime` is the port itself.
 * - **Limits.** `budget` (`checkFanout`, `charge`) and `control` (`paused`, `cancelled`).
 * - **Outcomes.** `recordFault` (a fault names its cause), `pause` (latches once; the reason
 *   and payload ride into the paused run), `noteItems` (progress and the live `items`
 *   event), `result` (the run's counters) and `checkpointAnswers` (`resolveCheckpoint`).
 */
export interface FlowDeps {
  readonly runId: string;
  readonly nodeScope: readonly string[];
  readonly runtime: ChildRuntime;
  readonly budget: Budget;
  readonly control: RunControl;
  readonly result: RunResult;
  readonly tiers: TierMap;
  readonly cache: WorkflowCache;
  readonly checkpointAnswers: Readonly<Record<string, unknown>>;
  readonly collectLeaf: (
    node: Node,
    prompt: string,
    schema: Readonly<Record<string, unknown>> | null,
    options: LeafCollectOptions,
  ) => Promise<LeafExecution>;
  readonly causal: (
    role: string,
    cellId: string,
    extra?: { itemIndex?: number; stageIndex?: number; attempt?: number },
  ) => CausalContext;
  readonly cell: (parts: readonly unknown[]) => string;
  readonly cacheGet: (hash: string) => unknown;
  readonly cachePut: (hash: string, nodeId: string, output: unknown, cost: Usage) => void;
  readonly schemaOf: (
    node: Node | Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>> | null;
  readonly pause: (
    reason: string,
    message: string,
    payload?: Readonly<Record<string, unknown>> | null,
  ) => void;
  readonly recordFault: (message: string) => void;
  readonly noteItems: (nodeId: string, done: number, total: number) => void;
}

export type FlowStrategy = (
  deps: FlowDeps,
  node: Node,
  context: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

const COMPLETENESS_SCHEMA = Object.freeze({
  type: "object",
  required: ["complete", "missing"],
  properties: {
    complete: { type: "boolean" },
    missing: { type: "array", items: { type: "string" } },
  },
});

async function runCompleteness(
  deps: FlowDeps,
  node: Node,
  context: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const task = strictResolve(node.fields.task, context);
  const results = strictResolve(node.fields.results, context);
  if (task === null || results === null) return null;
  const hash = deps.cell([
    node.id,
    "completeness_check",
    task,
    results,
    ...routingIdentity(node, deps.tiers),
  ]);
  const cached = deps.cacheGet(hash);
  if (cached !== CACHE_MISS) return cached;
  const leaf = await deps.collectLeaf(
    node,
    `Task: ${renderValue(task)}\nResults: ${renderValue(results)}`,
    COMPLETENESS_SCHEMA,
    { role: "completeness", cellId: hash },
  );
  if (leaf.output !== null) deps.cachePut(hash, node.id, leaf.output, leaf.usage);
  return leaf.output;
}

function runCheckpoint(
  deps: FlowDeps,
  node: Node,
  context: Readonly<Record<string, unknown>>,
): unknown {
  const prompt = strictResolve(node.fields.prompt, context);
  if (prompt === null) return null;
  const hash = deps.cell([node.id, "checkpoint", prompt]);
  const cached = deps.cacheGet(hash);
  if (cached !== CACHE_MISS) return cached;
  const resolved = resolveCheckpoint(deps.checkpointAnswers, deps.nodeScope, node.id);
  if (resolved.matched)
    return applyCheckpointAnswer(deps.cache, deps.runId, hash, resolved.scoped, resolved.answer);
  deps.pause("checkpoint", resolved.message, checkpointPausePayload(node, resolved, prompt));
  return null;
}

/**
 * The node types whose strategy lives outside `engine.ts`; `installStrategies` walks it.
 * A type is added here and in `NODE_SPECS` (`nodes.ts`), never in the engine.
 */
export const FLOW_STRATEGIES: Readonly<Record<string, FlowStrategy>> = Object.freeze({
  completeness_check: runCompleteness,
  checkpoint: (deps, node, context) => Promise.resolve(runCheckpoint(deps, node, context)),
});
