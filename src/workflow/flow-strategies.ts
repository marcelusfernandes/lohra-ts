import type { RunResult } from "./accounting.js";
import type { Budget } from "./budget.js";
import type { WorkflowCache } from "./cache.js";
import type { LeafExecution, RunControl } from "./engine-contract.js";
import type { CausalContext, ChildRuntime } from "./runtime.js";
import type { TierMap } from "./tiers.js";
import type { Node } from "./types.js";
import type { Usage } from "../pricing/types.js";

export interface LeafCollectOptions {
  readonly role: string;
  readonly cellId: string;
  readonly itemIndex?: number;
  readonly stageIndex?: number;
  readonly attempt?: number;
  readonly aborted?: () => boolean;
}

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

export const FLOW_STRATEGIES: Readonly<Record<string, FlowStrategy>> = Object.freeze({});
