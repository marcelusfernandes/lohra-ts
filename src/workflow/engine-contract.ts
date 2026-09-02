import type { Usage } from "../pricing/types.js";
import type { Budget } from "./budget.js";
import type { WorkflowCache } from "./cache.js";
import type { WorkflowEngine } from "./engine.js";
import type { BoundedPool } from "./pool.js";
import type { Awaitable, ChildRuntime } from "./runtime.js";
import type { TierMap } from "./tiers.js";
import type { Node } from "./types.js";

export const LEAF_TIMEOUT_SECONDS = 120;
export const PIPELINE_TIMEOUT_SECONDS = 1800;
export const MAX_WORKFLOW_DEPTH = 1;
export const DEFAULT_LEAF_MAX_ITERATIONS = 50;
export const EMPTY_OUTPUT_CORRECTION = "Your previous answer was empty. Produce a complete answer.";
export const VERIFY_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    refuted: Object.freeze({ type: "boolean" }),
    reason: Object.freeze({ type: "string" }),
  }),
  required: Object.freeze(["refuted"]),
});
export const JUDGE_SCORE_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    score: Object.freeze({ type: "number" }),
    rationale: Object.freeze({ type: "string" }),
  }),
  required: Object.freeze(["score"]),
});
export const GATE_VERDICT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    ok: Object.freeze({ type: "boolean" }),
    feedback: Object.freeze({ type: "string" }),
  }),
  required: Object.freeze(["ok"]),
});

export type WorkflowEvent = Readonly<{
  kind: "node" | "items" | "fault";
  nodeId: string;
  state?: string;
  done?: number;
  total?: number;
  text?: string;
}>;

export type WorkflowLoader = (reference: string) => Awaitable<unknown>;
export type Strategy = (
  engine: WorkflowEngine,
  node: Node,
  context: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export interface LeafExecution {
  readonly output: unknown;
  readonly usage: Usage;
  readonly complete: boolean;
}

export interface RunControl {
  cancelled: boolean;
  paused: boolean;
  pauseReason: string | null;
  pausePayload: Readonly<Record<string, unknown>> | null;
}

export const QUOTA_EXHAUSTED = "quota_exhausted";

export interface WorkflowEngineOptions {
  readonly runtime: ChildRuntime;
  readonly budget?: Budget;
  readonly cache?: WorkflowCache;
  readonly loader?: WorkflowLoader;
  readonly runId?: string;
  readonly segmentId?: string;
  readonly depth?: number;
  readonly nodeScope?: readonly string[];
  readonly checkpointAnswers?: Readonly<Record<string, unknown>>;
  readonly pipelineTimeoutSeconds?: number;
  readonly tiers?: TierMap;
  readonly onEvent?: (event: WorkflowEvent) => void;
  readonly logError?: (...args: unknown[]) => void;
  readonly pool?: BoundedPool;
  readonly control?: RunControl;
}
