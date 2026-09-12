// Issue #366: decorates a `ChildRuntime` so every leaf a `WorkflowEngine`
// spawns produces `leaf.started`/`leaf.completed`/`leaf.failed` in the audit
// ledger, keyed by the SAME causal identity the engine already builds per
// spawn (`CausalContext`: segment_id, node_path, attempt) plus the `sub_id`
// the spawn call itself returns.
//
// Issue #367 adds `tool.*`: `installLeafSandbox` hands `inner` a WRAPPED
// installation whose `wrap` produces `tool.started`/`tool.completed` for
// every tool call a leaf makes, keyed by the SAME `open` map below (get by
// `leaf.subId`, same identity `leaf.*` already uses) — never a second
// tracking structure.
//
// The fail-closed drop both appliers use — a durable stretch whose
// `ownershipOf()` returns `null` never reaches the ledger, a named `warn`
// instead — is the SAME rule `createWorkflowAuditProducers`
// (`audit-producers.ts`, #365) applies to `workflow.*` events; `#367`'s
// emenda (2026-09-11) put `audit-producers.ts` in this issue's `Files`
// specifically to export it as `recordAuditEvent`, so it is imported here,
// not repeated a second time.
//
// Issue #378: a leaf can close (cancel, shutdown-driven cancel, or the
// engine's own timeout) while one of its tool dispatches is still in
// flight — `tool.started` reached the ledger, but nothing ever calls
// `onToolSettled` for it (the real dispatch never gets to finish). `close()`
// below now flushes every such orphan as `tool.completed {status: "error",
// reason: "cancelled"}` before the leaf's own terminal event, so a `tool.*`
// pair is NEVER left incomplete — the same "exactly one terminal event"
// invariant `leaf.*` already gets, extended to `tool.*`.
import type { AuditInput } from "./audit-model.js";
import { recordAuditEvent, type AuditFailClosedDeps } from "./audit-producers.js";
import type { AuditTrail } from "./audit-trail.js";
import type {
  Awaitable,
  CausalContext,
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafIdentity,
  LeafSandboxHandle,
  LeafSandboxInstallation,
  LeafToolDispatch,
} from "./runtime.js";
import type { Ownership } from "../state/workflow-repository.js";
import { BUILTIN_DEFINITIONS } from "../tools/builtin-definitions.js";

export type AuditedChildRuntimeDeps = AuditFailClosedDeps;

/**
 * Issue #423 (M10-S2): `ChildRuntime.steer`'s port signature (`runtime.ts`,
 * out of this issue's `Files`) has no source marker — the engine's own
 * `causal` (engine.ts:304-308) never carries one. Rather than widen the
 * port (which every OTHER `ChildRuntime` implementation would then have to
 * satisfy), the decorator's OWN `steer` grows a 4th parameter, `source`,
 * only visible through this wider type: any caller that holds the plain
 * `ChildRuntime` the port declares keeps calling `steer` with 3 args and
 * gets `"engine"` by default (what the engine's schema-retry steer already
 * does); a caller that holds the concrete `AuditedChildRuntime` — the
 * operator-steer tool of a later issue (S3) — can pass `"operator"`
 * explicitly. `runtime.ts` stays untouched.
 */
export interface AuditedChildRuntime extends ChildRuntime {
  readonly steer: (
    id: string,
    prompt: string,
    causalContext?: CausalContext,
    source?: "engine" | "operator",
  ) => Awaitable<void>;
}

// `pending` is a mutable counter, same pattern as `auditedToolDispatch`'s own
// local `state: { reached }` below — how many of THIS leaf's tool dispatches
// have a `tool.started` on the ledger with no `tool.completed` yet (in
// flight through the real async dispatch, never a sync denial: that path
// closes its own pair before returning). `close()` reads it to flush any
// leftover as `tool.completed {reason: "cancelled"}` before the leaf's own
// terminal event (#378).
type OpenLeaf = Readonly<{ runId: string; causal: CausalContext; pending: { count: number } }>;

function usagePayload(result: ChildResult): Readonly<Record<string, number>> | undefined {
  const usage = result.usage;
  if (usage === undefined || usage === null) return undefined;
  return { tokens_in: usage.inputTokens, tokens_out: usage.outputTokens };
}

// Issue #367: any tool name outside the builtin catalog is a hallucinated
// call — `tool_name_state` classifies it, never leaks it (`name` stays a
// RAW_FIELD, audit-model.ts:52). Built once, not per call: the catalog is a
// module-level constant.
//
// Issue #378: an MCP tool's real name (`mcp_{server}_{tool}`, mcp/tools.ts)
// is registered into a per-RUN `ToolRegistry` at launch time — this
// decorator is built once, independent of any run's registry, and has no
// seam to reach it. Every `mcp_*` call is therefore classified
// `unknown_tool` here, legitimate or not; `tests/workflow-audit-tool.test.ts`
// pins that as the documented behavior, not a bug to fix in this issue.
const KNOWN_TOOL_NAMES = new Set<string>(
  BUILTIN_DEFINITIONS.map((definition) => definition.function.name),
);

/**
 * Wraps ONE acquisition's real policy wrap (`policyWrap`, e.g. service.ts's
 * `stretchToolDispatch`) so every tool call a leaf makes produces
 * `tool.started` and, for a SYNC denial only, an immediate `tool.completed
 * {reason: "sandbox_denied"}` — settlement for a call that actually reached
 * the real dispatch comes later, from `onToolSettled` (installLeafSandbox
 * below), never from here.
 *
 * Calls `policyWrap` exactly ONCE, same as `adaptSandboxWrap`
 * (orchestration-runtime.ts) calls the wrap THIS function returns exactly
 * once — `reached` is reset per call, not per installation, so it never
 * confuses one tool call's denial with another's.
 *
 * `reached` — not a token/type check on the return value — is how a sync
 * denial is told apart from a real dispatch in flight: `spiedBase` only
 * flips it when the policy wrap actually calls all the way through to the
 * real base dispatch, which is exactly the contract `adaptSandboxWrap`'s own
 * docstring states ("a denial never called `base` at all"). This keeps this
 * module ignorant of `adaptSandboxWrap`'s internal pending-token shim.
 */
function auditedToolDispatch(
  base: LeafToolDispatch,
  policyWrap: (base: LeafToolDispatch, leaf?: LeafIdentity) => LeafToolDispatch,
  leaf: LeafIdentity,
  open: ReadonlyMap<string, OpenLeaf>,
  deps: AuditedChildRuntimeDeps,
): LeafToolDispatch {
  // `no-unnecessary-condition`'s flow analysis does not see `spiedBase`
  // (created once, below) run through the opaque `dispatchAfterPolicy` on
  // every call, so a plain field read narrows straight back to the literal
  // it was just assigned a few lines up. Reading it back through a function
  // call — not a property access — is what actually defeats that false
  // narrowing (a call's return value is never assumed pinned to a prior
  // assignment the way a bare property read is).
  const state: { reached: boolean } = { reached: false };
  const wasReached = (): boolean => state.reached;
  const spiedBase: LeafToolDispatch = (name, args) => {
    state.reached = true;
    return base(name, args);
  };
  const dispatchAfterPolicy = policyWrap(spiedBase, leaf);
  return (name, args) => {
    state.reached = false;
    const openLeaf = open.get(leaf.subId);
    if (openLeaf === undefined) return dispatchAfterPolicy(name, args);
    const cc = openLeaf.causal;
    const identity = {
      segment_id: cc.segmentId,
      node_id: cc.nodePath.at(-1) ?? null,
      sub_id: leaf.subId,
      attempt: cc.attempt,
    };
    recordAuditEvent(deps, openLeaf.runId, {
      event_type: "tool.started",
      ...identity,
      payload: {
        tool_name_state: KNOWN_TOOL_NAMES.has(name) ? "known_tool" : "unknown_tool",
        fields: Object.keys(args).length,
      },
    });
    // #378: counted from `tool.started` until this dispatch's own
    // `tool.completed` — a sync denial below closes its pair immediately; an
    // async one closes it from `onToolSettled` (installLeafSandbox below),
    // or, if the leaf closes first, from `close()`'s flush.
    openLeaf.pending.count += 1;
    const out = dispatchAfterPolicy(name, args);
    if (!wasReached()) {
      recordAuditEvent(deps, openLeaf.runId, {
        event_type: "tool.completed",
        ...identity,
        payload: { status: "error", reason: "sandbox_denied" },
      });
      openLeaf.pending.count -= 1;
    }
    return out;
  };
}

/**
 * Decorates `inner`: every method delegates, but `spawn`/`collect`/`cancel`
 * also produce `leaf.*` audit events from the identity `inner.spawn`'s
 * `causalContext` already carries. A leaf gets EXACTLY one terminal event —
 * `open` loses its entry (get-then-delete, atomic in this single-threaded
 * decorator) at the FIRST terminal outcome, so the engine's post-steer
 * re-`collect` on the same id (schema retry) and its post-timeout `cancel`
 * never produce a second one.
 *
 * Issue #378: the same "exactly one terminal" guarantee now extends to
 * `tool.*` — `close()` flushes any of THIS leaf's still-open tool dispatches
 * (`tool.started` with no `tool.completed` yet: cancel, shutdown-driven
 * cancel, or the engine's own timeout, all reach `close()`) as
 * `tool.completed {status: "error", reason: "cancelled"}`, ordered before
 * the leaf's own terminal event, so a `tool.*` pair is never left orphaned.
 */
export function auditedChildRuntime(
  inner: ChildRuntime,
  deps: AuditedChildRuntimeDeps,
): AuditedChildRuntime {
  const open = new Map<string, OpenLeaf>();
  // Issue #423: `steer()`'s identity source. NOT `open` — `close()` deletes
  // a leaf's `open` entry at its FIRST terminal `collect()` (`status:
  // "complete"`, unconditionally, before the engine ever checks a schema),
  // so a schema-retry's `steer()` — called AFTER that terminal, on the SAME
  // id — always finds `open.get(id) === undefined`. This registry is
  // populated once, at `spawn()`, alongside `open`, and NEVER deleted by
  // `close()`: bounded by the leaves ONE acquisition spawns (the same
  // lifetime `open` has — a fresh decorator instance per `launch`/
  // `launchDurable`, service.ts), never read once that stretch ends.
  // Consequence: `leaf.steered.attempt` is always the SPAWN attempt (the
  // same one `leaf.started`/`tool.*` for that `sub_id` carry), not a
  // retry index the engine may have bumped for the `causalContext` argument
  // `steer()` itself received (still passed through to `inner.steer`
  // unchanged, just not used for this event's identity).
  const identities = new Map<string, Readonly<{ runId: string; causal: CausalContext }>>();

  function record(runId: string, input: AuditInput): void {
    recordAuditEvent(deps, runId, input);
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
    for (let index = 0; index < leaf.pending.count; index += 1) {
      record(leaf.runId, {
        event_type: "tool.completed",
        segment_id: cc.segmentId,
        node_id: cc.nodePath.at(-1) ?? null,
        sub_id: id,
        attempt: cc.attempt,
        payload: { status: "error", reason: "cancelled" },
      });
    }
    record(leaf.runId, {
      event_type: eventType,
      segment_id: cc.segmentId,
      node_id: cc.nodePath.at(-1) ?? null,
      sub_id: id,
      attempt: cc.attempt,
      payload,
    });
  }

  const runtime: AuditedChildRuntime = {
    async spawn(request: ChildSpawnRequest): Promise<string> {
      const id = await inner.spawn(request);
      const cc = request.causalContext;
      open.set(id, { runId: cc.runId, causal: cc, pending: { count: 0 } });
      identities.set(id, { runId: cc.runId, causal: cc });
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
    // Issue #423: `leaf.steered` is metadata-only — never the prompt text,
    // only `message_chars` (same `Array.from(...).length` convention this
    // file's own `clipped` helper — audit-model.ts — uses for unicode-safe
    // counts). Identity comes from `identities.get(id).causal` (declared
    // above, next to `open`) — a schema retry's `steer` (engine.ts:304-308)
    // runs AFTER the leaf's `open` entry is already gone (its first
    // `collect()` returned `status: "complete"`, closing it, BEFORE the
    // engine's own schema check runs) — never the (possibly bumped-attempt)
    // `causalContext` argument this call carries, which still passes
    // through to `inner.steer` unchanged. A `steer` on an id this decorator
    // never spawned still delegates, just without an audit event — same
    // fail-open-to-the-port rule `auditedToolDispatch` follows when `open`
    // has no entry.
    steer: (
      id: string,
      prompt: string,
      causalContext?: CausalContext,
      source: "engine" | "operator" = "engine",
    ) => {
      const identity = identities.get(id);
      if (identity !== undefined) {
        const cc = identity.causal;
        record(identity.runId, {
          event_type: "leaf.steered",
          segment_id: cc.segmentId,
          node_id: cc.nodePath.at(-1) ?? null,
          sub_id: id,
          attempt: cc.attempt,
          payload: { source, message_chars: Array.from(prompt).length },
        });
      }
      return inner.steer(id, prompt, causalContext);
    },
    // `causalSnapshot` only delegates. `exactOptionalPropertyTypes` requires
    // these be OMITTED, not assigned `undefined`, when `inner` does not have
    // one.
    ...(inner.causalSnapshot === undefined
      ? {}
      : {
          causalSnapshot: (id: string): ReturnType<NonNullable<ChildRuntime["causalSnapshot"]>> =>
            (inner.causalSnapshot as NonNullable<ChildRuntime["causalSnapshot"]>)(id),
        }),
    // Issue #367: `installLeafSandbox` hands `inner` a WRAPPED installation —
    // `wrap` produces `tool.*` around whatever the caller's OWN policy wrap
    // (e.g. service.ts's `stretchToolDispatch`) decides, keyed by `open` (the
    // SAME map `spawn`/`close` above populate, so `tool.*` and `leaf.*` share
    // one identity source). A `leaf` the caller never supplies (a test
    // predating this issue) skips the audit wrap entirely rather than guess
    // an identity — `installation.wrap(base, leaf)` still runs unaudited.
    ...(inner.installLeafSandbox === undefined
      ? {}
      : {
          installLeafSandbox: (installation: LeafSandboxInstallation): LeafSandboxHandle =>
            (inner.installLeafSandbox as NonNullable<ChildRuntime["installLeafSandbox"]>)({
              ...installation,
              wrap: (base, leaf) =>
                leaf === undefined
                  ? installation.wrap(base, leaf)
                  : auditedToolDispatch(base, installation.wrap, leaf, open, deps),
              onToolSettled: (leaf, ok) => {
                const openLeaf = open.get(leaf.subId);
                if (openLeaf !== undefined) {
                  const cc = openLeaf.causal;
                  record(openLeaf.runId, {
                    event_type: "tool.completed",
                    segment_id: cc.segmentId,
                    node_id: cc.nodePath.at(-1) ?? null,
                    sub_id: leaf.subId,
                    attempt: cc.attempt,
                    payload: { status: ok ? "success" : "error" },
                  });
                  // #378: this dispatch's own settle — never reached if the
                  // leaf already closed (`openLeaf` would be `undefined`
                  // above; `close()` already flushed it as cancelled).
                  openLeaf.pending.count = Math.max(0, openLeaf.pending.count - 1);
                }
                installation.onToolSettled?.(leaf, ok);
              },
            }),
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
): AuditedChildRuntime {
  return auditedChildRuntime(runtime, { trail, ownershipOf, durable, warn });
}

/**
 * `service.ts`'s durable launch needs BOTH the audited runtime (handed to
 * the engine as `spawn`/`collect`/`cancel`) AND its `installLeafSandbox`,
 * bound to the SAME decorator instance — issue #367, emenda 2026-09-11.
 * Two SEPARATE `auditedRuntimeFor(...)` calls would each mint their own
 * `open` map (audit-runtime.ts's per-leaf identity table); installing
 * through one and spawning through the other would leave `tool.*`'s lookup
 * always empty, silently never firing. One call, one instance, both uses.
 */
export function auditInstall(
  runtime: ChildRuntime,
  trail: AuditTrail | undefined,
  ownershipOf: () => Ownership | null,
  warn: (message: string) => void,
): readonly [
  AuditedChildRuntime,
  ((installation: LeafSandboxInstallation) => LeafSandboxHandle) | undefined,
] {
  const rt = auditedRuntimeFor(runtime, trail, ownershipOf, true, warn);
  return [rt, rt.installLeafSandbox?.bind(rt)];
}
