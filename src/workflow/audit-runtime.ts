// Issue #366: decorates a `ChildRuntime` so every leaf a `WorkflowEngine`
// spawns produces `leaf.started`/`leaf.completed`/`leaf.failed` in the audit
// ledger, keyed by the SAME causal identity the engine already builds per
// spawn (`CausalContext`: segment_id, node_path, attempt) plus the `sub_id`
// the spawn call itself returns.
//
// The fail-closed drop this applies — a durable stretch whose `ownershipOf()`
// returns `null` never reaches the ledger, a named `warn` instead — is the
// SAME rule `createWorkflowAuditProducers` (`audit-producers.ts`, #365)
// applies to `workflow.*` events. That closure is private to its own factory
// and `audit-producers.ts` is not a file this issue may touch (`service.ts`
// is already at its own zero-growth ceiling there), so the two-line check is
// repeated here rather than imported.
import type { AuditInput } from "./audit-model.js";
import type { AuditTrail } from "./audit-trail.js";
import type {
  CausalContext,
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
  LeafSandboxInstallation,
} from "./runtime.js";
import type { Ownership } from "../state/workflow-repository.js";

export interface AuditedChildRuntimeDeps {
  readonly trail: AuditTrail | undefined;
  /** `stretchOwnership` in the durable path; `() => null` outside it — read
   * FRESH on every call, never captured once. */
  readonly ownershipOf: () => Ownership | null;
  /** `true` only for the durable path: the fail-closed drop below only
   * applies where a fence exists to lose in the first place. */
  readonly durable: boolean;
  readonly warn: (message: string) => void;
}

type OpenLeaf = Readonly<{ runId: string; causal: CausalContext }>;

function usagePayload(result: ChildResult): Readonly<Record<string, number>> | undefined {
  const usage = result.usage;
  if (usage === undefined || usage === null) return undefined;
  return { tokens_in: usage.inputTokens, tokens_out: usage.outputTokens };
}

/**
 * Decorates `inner`: every method delegates, but `spawn`/`collect`/`cancel`
 * also produce `leaf.*` audit events from the identity `inner.spawn`'s
 * `causalContext` already carries. A leaf gets EXACTLY one terminal event —
 * `open` loses its entry (get-then-delete, atomic in this single-threaded
 * decorator) at the FIRST terminal outcome, so the engine's post-steer
 * re-`collect` on the same id (schema retry) and its post-timeout `cancel`
 * never produce a second one.
 */
export function auditedChildRuntime(
  inner: ChildRuntime,
  deps: AuditedChildRuntimeDeps,
): ChildRuntime {
  const { trail, ownershipOf, durable, warn } = deps;
  const open = new Map<string, OpenLeaf>();

  function record(runId: string, input: AuditInput): void {
    if (trail === undefined) return;
    const ownership = ownershipOf();
    if (durable && ownership === null) {
      warn(
        `workflow: audit leaf event dropped for run ${runId} — ownership lost (${input.event_type})`,
      );
      return;
    }
    trail.record(runId, input, ownership ?? undefined);
  }

  function close(
    id: string,
    eventType: "leaf.completed" | "leaf.failed",
    payload: Readonly<Record<string, unknown>>,
  ): void {
    const leaf = open.get(id);
    if (leaf === undefined) return;
    open.delete(id);
    const cc = leaf.causal;
    record(leaf.runId, {
      event_type: eventType,
      segment_id: cc.segmentId,
      node_id: cc.nodePath.at(-1) ?? null,
      sub_id: id,
      attempt: cc.attempt,
      payload,
    });
  }

  const runtime: ChildRuntime = {
    async spawn(request: ChildSpawnRequest): Promise<string> {
      const id = await inner.spawn(request);
      const cc = request.causalContext;
      open.set(id, { runId: cc.runId, causal: cc });
      record(cc.runId, {
        event_type: "leaf.started",
        segment_id: cc.segmentId,
        node_id: cc.nodePath.at(-1) ?? null,
        sub_id: id,
        attempt: cc.attempt,
        payload: {
          role: cc.role,
          node_path: cc.nodePath,
          ...(cc.itemIndex === undefined ? {} : { item_index: cc.itemIndex }),
          ...(cc.stageIndex === undefined ? {} : { stage_index: cc.stageIndex }),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.provider === undefined ? {} : { provider: request.provider }),
          ...(request.maxIterations === undefined ? {} : { max_iterations: request.maxIterations }),
        },
      });
      return id;
    },
    async collect(id: string, options: ChildCollectOptions): Promise<ChildResult> {
      let result: ChildResult;
      try {
        result = await inner.collect(id, options);
      } catch (error) {
        close(id, "leaf.failed", { status: "failed" });
        throw error;
      }
      if (result.status === "complete") {
        close(id, "leaf.completed", {
          status: "complete",
          ...(usagePayload(result) === undefined ? {} : { usage: usagePayload(result) }),
          ...(result.model === undefined || result.model === null ? {} : { model: result.model }),
          ...(result.provider === undefined || result.provider === null
            ? {}
            : { provider: result.provider }),
          usage_uncertain: result.usageUncertain === true,
          forced_fallback: result.forcedFallback === true,
        });
      } else if (result.status === "failed" || result.status === "cancelled") {
        close(id, "leaf.failed", {
          status: result.status,
          ...(result.errorKind === undefined || result.errorKind === null
            ? {}
            : { error_kind: result.errorKind }),
          usage_uncertain: result.usageUncertain === true,
        });
      } else if (options.wait) {
        // `result.status` here can only be "running": the engine treats a
        // `wait: true` collect that comes back "running" as a leaf timeout
        // (`engine.ts:270-274`) and follows up with its own `cancel(id)` —
        // already closed here, so that cancel is a no-op below.
        close(id, "leaf.failed", {
          status: "interrupted",
          reason: "timeout",
          timeout_seconds: options.timeoutSeconds,
        });
      }
      return result;
    },
    async cancel(id: string): Promise<void> {
      try {
        await inner.cancel(id);
      } finally {
        close(id, "leaf.failed", { status: "cancelled", reason: "cancelled" });
      }
    },
    steer: (id: string, prompt: string, causalContext?: CausalContext) =>
      inner.steer(id, prompt, causalContext),
    // `causalSnapshot`/`installLeafSandbox` only delegate — the audited wrap
    // of leaf TOOL dispatch is the `tool.*` sub-issue (#367), not this one.
    // `exactOptionalPropertyTypes` requires these be OMITTED, not assigned
    // `undefined`, when `inner` does not have one.
    ...(inner.causalSnapshot === undefined
      ? {}
      : {
          causalSnapshot: (id: string): ReturnType<NonNullable<ChildRuntime["causalSnapshot"]>> =>
            (inner.causalSnapshot as NonNullable<ChildRuntime["causalSnapshot"]>)(id),
        }),
    ...(inner.installLeafSandbox === undefined
      ? {}
      : {
          installLeafSandbox: (installation: LeafSandboxInstallation): LeafSandboxHandle =>
            (inner.installLeafSandbox as NonNullable<ChildRuntime["installLeafSandbox"]>)(
              installation,
            ),
        }),
  };
  return runtime;
}

/** One-line call site for `WorkflowService`'s two engine constructions
 * (`ao/durable-launch-site-forgets-the-tier-map` in
 * `workflow-durability-named.ts` anchors the durable one's `engineBaseOptions`
 * call byte for byte — this keeps that call site a single argument). */
export function auditedRuntimeFor(
  runtime: ChildRuntime,
  trail: AuditTrail | undefined,
  ownershipOf: () => Ownership | null,
  durable: boolean,
  warn: (message: string) => void,
): ChildRuntime {
  return auditedChildRuntime(runtime, { trail, ownershipOf, durable, warn });
}
