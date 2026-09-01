import type { Usage } from "../pricing/types.js";

export interface CausalContext {
  readonly runId: string;
  readonly segmentId: string;
  readonly nodePath: readonly string[];
  readonly cellId: string;
  readonly role: string;
  readonly itemIndex?: number;
  readonly stageIndex?: number;
  readonly attempt: number;
  readonly turn: number;
}
export interface ChildSpawnRequest {
  readonly prompt: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly forcedTool?: Readonly<Record<string, unknown>>;
  readonly maxIterations?: number;
  readonly causalContext: CausalContext;
}

export interface ChildCollectOptions {
  readonly wait: boolean;
  readonly timeoutSeconds: number;
}

export interface ChildResult {
  readonly status: "running" | "complete" | "failed" | "cancelled";
  readonly output: unknown;
  readonly usage?: Usage | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly forcedFallback?: boolean;
  readonly retryAfter?: number | null;
  readonly errorKind?: string | null;
  readonly toolCalls?: readonly Readonly<Record<string, unknown>>[];
}

export type Awaitable<T> = T | Promise<T>;

/** Provider-free port consumed by the workflow core. */
export interface ChildRuntime {
  spawn(request: ChildSpawnRequest): Awaitable<string>;
  collect(id: string, options: ChildCollectOptions): Awaitable<ChildResult>;
  steer(id: string, prompt: string, causalContext?: CausalContext): Awaitable<void>;
  cancel(id: string): Awaitable<void>;
  causalSnapshot?(id: string): Awaitable<CausalContext | null>;
}
