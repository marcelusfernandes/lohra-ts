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

/** How a leaf runs one of its tools. */
export type LeafToolDispatch = (
  name: string,
  args: Readonly<Record<string, unknown>>,
) => string;

/**
 * One ACQUISITION's leaf sandbox, handed to the runtime before any leaf of that
 * stretch spawns. `fence` is the token the acquisition holds and never changes:
 * a runtime keys installations by it, so an older stretch can neither overwrite
 * nor uninstall a newer acquisition's dispatch.
 */
export interface LeafSandboxInstallation {
  readonly runId: string;
  readonly fence: number;
  /**
   * Exactly the service's composition: operator policy + this acquisition's
   * working root + live taint. The runtime must route every leaf tool call
   * through the returned dispatch.
   */
  readonly wrap: (base: LeafToolDispatch) => LeafToolDispatch;
}

/** Removes ONLY the installation it came from. */
export interface LeafSandboxHandle {
  dispose(): void;
}

/** Provider-free port consumed by the workflow core. */
export interface ChildRuntime {
  spawn(request: ChildSpawnRequest): Awaitable<string>;
  collect(id: string, options: ChildCollectOptions): Awaitable<ChildResult>;
  steer(id: string, prompt: string, causalContext?: CausalContext): Awaitable<void>;
  cancel(id: string): Awaitable<void>;
  causalSnapshot?(id: string): Awaitable<CausalContext | null>;
  /**
   * Install this acquisition's leaf sandbox.
   *
   * Structurally optional, so the non-durable T15 runtimes keep compiling. It
   * is NOT optional in practice: a `WorkflowService` running with a durable
   * store REQUIRES it and refuses the launch fail-closed when it is absent,
   * before any leaf spawns. The optionality is compatibility, not permission to
   * run leaves unsandboxed.
   */
  installLeafSandbox?(installation: LeafSandboxInstallation): LeafSandboxHandle;
}
