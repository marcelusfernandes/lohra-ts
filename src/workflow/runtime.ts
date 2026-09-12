import type { Usage } from "../pricing/types.js";
import type { ErrorKind } from "../transports/error-kinds.js";

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
  readonly retryAfter?: number | null;
  readonly errorKind?: ErrorKind | null;
  readonly toolCalls?: readonly Readonly<Record<string, unknown>>[];
  /** True when `usage` above is a stand-in for a measurement that never
   * happened (child died before reporting, provider/resolution error) —
   * never true for a turn that genuinely spent zero tokens (#232). */
  readonly usageUncertain?: boolean;
  /** How many of this leaf's own tool calls the sandbox denied before they
   * ever reached the real dispatch — the runtime's side channel populates
   * this (OrchestrationChildRuntime, orchestration-runtime.ts), never the
   * leaf itself. Absent/0 means no denial; never negative (#246). */
  readonly sandboxRefusals?: number;
}

export type Awaitable<T> = T | Promise<T>;

/** How a leaf runs one of its tools. */
export type LeafToolDispatch = (name: string, args: Readonly<Record<string, unknown>>) => string;

/**
 * One ACQUISITION's leaf sandbox, handed to the runtime before any leaf of that
 * stretch spawns. `fence` is the token the acquisition holds and never changes:
 * a runtime keys installations by it, so an older stretch can neither overwrite
 * nor uninstall a newer acquisition's dispatch.
 */
/** The leaf a tool call belongs to — issue #367: just enough for a wrap to
 * key audit identity or policy by, never a place to smuggle prompt/output
 * text through. */
export type LeafIdentity = Readonly<{ subId: string }>;

export interface LeafSandboxInstallation {
  readonly runId: string;
  readonly fence: number;
  /**
   * Exactly the service's composition: operator policy + this acquisition's
   * working root + live taint. The runtime must route every leaf tool call
   * through the returned dispatch. `leaf` (issue #367) is the calling leaf's
   * identity — OPTIONAL so callers that build a `LeafSandboxInstallation`
   * directly (tests predating this issue) keep compiling unchanged; every
   * PRODUCTION caller (`adaptSandboxWrap`, orchestration-runtime.ts) always
   * supplies it.
   */
  readonly wrap: (base: LeafToolDispatch, leaf?: LeafIdentity) => LeafToolDispatch;
  /**
   * Fires once per tool call, after the REAL async dispatch settles — never
   * for a synchronous denial (that never reaches the async leg at all; see
   * `adaptSandboxWrap`, orchestration-runtime.ts). `ok` mirrors the tool
   * envelope's own `ok` field (`src/tools/envelope.ts`), not exceptions: a
   * tool that resolves with an error string still settles, `ok: false`.
   */
  readonly onToolSettled?: (leaf: LeafIdentity, ok: boolean) => void;
}

/** Removes ONLY the installation it came from. */
export interface LeafSandboxHandle {
  dispose(): void;
}

/**
 * `OrchestrationCore.steer`'s own return shape (`orchestration/core.ts`,
 * out of this issue's `Files` — structural, not re-exported, so this type
 * is declared once here and matched by shape): `queued: true` when a busy
 * leaf's steer text was pushed to the core's own inbox, `queued: false` (no
 * `refused`) when an idle/terminal leaf was resurrected with a fresh turn —
 * both are genuine deliveries. `refused: "steer_cap"` is the only refusal
 * shape today (issue #424 S1's per-leaf pending-steer cap).
 */
export type SteerOutcome = Readonly<{ queued: boolean; refused?: "steer_cap" }>;

/** Provider-free port consumed by the workflow core. */
export interface ChildRuntime {
  spawn(request: ChildSpawnRequest): Awaitable<string>;
  collect(id: string, options: ChildCollectOptions): Awaitable<ChildResult>;
  steer(id: string, prompt: string, causalContext?: CausalContext): Awaitable<void>;
  cancel(id: string): Awaitable<void>;
  causalSnapshot?(id: string): Awaitable<CausalContext | null>;
  /**
   * Issue #450 (PR #443 veredito, non_blocking a-1/a-2): the REAL outcome
   * of a steer call, for a runtime that can report one. `steer` above stays
   * `Awaitable<void>` — every existing `ChildRuntime` slot the port flows
   * into (`chat.ts`, `dashboard.ts`, `service.ts`, none in this issue's
   * `Files`) would otherwise have to satisfy a wider return, and a union
   * that merely CONTAINS `void` does not get TypeScript's void-return
   * leniency (confirmed empirically — the constraint that sank the
   * original, simpler attempt at widening `steer` itself). This is
   * therefore a NEW, OPTIONAL member, same shape as `causalSnapshot?`
   * above, never a wider `steer`.
   *
   * `null` means the id is terminal/unknown to the runtime — a real
   * answer, distinct from a refusal. A runtime that omits this member
   * entirely (every `ChildRuntime` before `OrchestrationChildRuntime`)
   * reports nothing at all; callers (`AuditedChildRuntime`, `workflow_steer`
   * in `steer-tool.ts`) treat "absent" and "null" as the same fact — no
   * proof of delivery — but never conflate "absent" with `refused`.
   */
  steerOutcome?(
    id: string,
    prompt: string,
    causalContext?: CausalContext,
  ): Awaitable<SteerOutcome | null>;
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
