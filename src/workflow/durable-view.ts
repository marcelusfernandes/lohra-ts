// Issue #969: the durable run line's read model — moved out of `service.ts`
// (its own zero-growth ceiling; same move as #365/#463) to pay for the lines
// #970/#971/#972 add there. `service.ts` re-exports every name below, so no
// importer of `service.js` changes.
import { loadsOr } from "./jsonio.js";
import { pivotsOf } from "./route-override.js";
import { artifactsOf, pauseFields } from "./service-rollup.js";
import { isErrorKind, type ErrorKind } from "../transports/error-kinds.js";

export const STALE_HINT =
  "the process that was running this workflow was lost before it finished; the " +
  "cells it completed are kept — run_workflow(resume_run_id=...) continues it";
export const BUSY_HINT = "another process is running this workflow right now";

export interface DurableRunView {
  readonly run_id: string;
  readonly name: string;
  readonly owner: string | null;
  readonly status: string;
  readonly pause_reason: string | null;
  readonly checkpoint: Record<string, unknown> | null;
  readonly resume_at: number | null;
  readonly attempts: number;
  readonly leaf_respawns: number;
  readonly sandbox_refusals: number;
  readonly prior_faults: readonly string[];
  readonly prior_fault_kinds: readonly ErrorKind[];
  readonly prior_degraded: boolean;
  readonly tainted: boolean;
  readonly spec: Record<string, unknown> | null;
  readonly args: Readonly<Record<string, unknown>>;
  readonly token_budget: number | null;
  /** #427: past route pivots this run has already spent — folded forward
   * on every terminal write (`pausePayloadOf`, route-override.ts). */
  readonly pivots: readonly { provider?: string; model?: string }[]; // RouteOverride's shape, inlined (#446)
  /** #463: the write-file manifest/collision faults folded forward the
   * same way `pivots` above is (`pausePayloadOf`, route-override.ts). */
  readonly artifacts: readonly { node_id: string; sub_id: string; path: string; bytes: number }[];
  readonly artifact_faults: readonly string[];
  readonly progress: Record<string, unknown> | null;
  readonly audit_segment_id: string | null;
  /** #971: the library template the run was started from (`null` inline). */
  readonly template_ref: string | null;
  readonly template_hash: string | null;
  readonly updated_at: number;
}

export function durableFromRow(row: Readonly<Record<string, unknown>>): DurableRunView {
  const payload = loadsOr(row.pause_payload_json, {}) as Record<string, unknown>;
  const faults = payload.prior_faults;
  const faultKinds = payload.prior_fault_kinds;
  const artifactFaults = payload.artifact_faults;
  const checkpoint = payload.checkpoint;
  const progress = loadsOr(row.progress_json, null);
  const spec = loadsOr(row.spec_json, null);
  const args = loadsOr(row.args_json, {});
  return {
    run_id: String(row.run_id),
    name: typeof row.name === "string" ? row.name : "",
    owner: typeof row.owner === "string" ? row.owner : null,
    status: typeof row.status === "string" ? row.status : "running",
    pause_reason: typeof row.pause_reason === "string" ? row.pause_reason : null,
    checkpoint:
      checkpoint !== null && typeof checkpoint === "object"
        ? (checkpoint as Record<string, unknown>)
        : null,
    resume_at: typeof payload.resume_at === "number" ? payload.resume_at : null,
    attempts: Number(payload.attempts ?? 0),
    leaf_respawns: Number(payload.leaf_respawns ?? 0),
    sandbox_refusals: Number(payload.sandbox_refusals ?? 0),
    prior_faults: Array.isArray(faults) ? faults.map((fault) => String(fault)) : [],
    prior_fault_kinds: Array.isArray(faultKinds) ? faultKinds.map(String).filter(isErrorKind) : [],
    prior_degraded: payload.prior_degraded === true,
    tainted: Number(row.tainted ?? 0) === 1,
    spec: spec !== null && typeof spec === "object" ? (spec as Record<string, unknown>) : null,
    args: args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {},
    token_budget:
      row.token_budget === null || row.token_budget === undefined ? null : Number(row.token_budget),
    pivots: pivotsOf(payload),
    artifacts: artifactsOf(payload),
    artifact_faults: Array.isArray(artifactFaults) ? artifactFaults.map(String) : [],
    progress:
      progress !== null && typeof progress === "object"
        ? (progress as Record<string, unknown>)
        : null,
    audit_segment_id:
      row.audit_segment_id === null || row.audit_segment_id === undefined
        ? null
        : (row.audit_segment_id as string),
    template_ref: typeof row.template_ref === "string" ? row.template_ref : null,
    template_hash: typeof row.template_hash === "string" ? row.template_hash : null,
    updated_at: Number(row.updated_at ?? 0),
  };
}

export function durableRollup(
  view: DurableRunView,
  spentTotal: number,
  stale: boolean,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = { run_id: view.run_id, status: view.status };
  const pause = pauseFields(view);
  if (pause !== null) Object.assign(out, pause);
  out.tokens_spent_total = spentTotal;
  out.leaf_respawns = view.leaf_respawns;
  out.sandbox_refusals = view.sandbox_refusals;
  if (view.progress !== null && Number(view.progress.total ?? 0) > 0) out.progress = view.progress;
  if (view.prior_faults.length > 0) out.faults_total = [...view.prior_faults];
  if (view.prior_fault_kinds.length > 0) out.fault_kinds_total = [...view.prior_fault_kinds];
  if (view.pivots.length > 0) out.pivots = [...view.pivots];
  if (view.artifacts.length > 0) out.artifacts = [...view.artifacts];
  if (view.artifact_faults.length > 0) out.artifact_faults = [...view.artifact_faults];
  if (view.name !== "") out.name = view.name;
  if (view.template_ref !== null) out.template_ref = view.template_ref; // #971
  if (view.status === "running") {
    out.stale = stale;
    out.hint = stale ? STALE_HINT : BUSY_HINT;
  }
  return Object.freeze(out);
}
