// Issue #971 (épico #969): `run_workflow {template: "<ref>"}` runs a saved
// template by name — the model no longer re-sends the whole spec — and the
// run keeps where it came from (`template_ref` + `template_hash` on
// `workflow_run_state`). Resolution lives here so `service.ts` only threads
// the result; the loaded spec then takes the exact path an inline `spec`
// takes (`validateSpec`, `validateNestedRefs`, caps, `token_budget`).
import { createHash } from "node:crypto";

import type { WorkflowLoader } from "./engine-contract.js";

/** Where a run's spec came from. `hash` tells two editions of one `ref`
 * apart — an operator may edit their own file by hand between runs. */
export interface RunTemplateOrigin {
  readonly ref: string;
  readonly hash: string;
}

/** sha256 of the template's JSON as loaded (key order as on disk). */
export function templateHash(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(raw)).digest("hex");
}

export type TemplateLaunch =
  | { readonly raw: unknown; readonly origin: RunTemplateOrigin }
  | { readonly error: string; readonly invalidSpec?: true };

/** `null` when the launch names no template. Every refusal is named and
 * happens before anything is acquired or spawned. */
export function resolveTemplateLaunch(
  loader: WorkflowLoader | undefined,
  ref: string | undefined,
  rawSpec: unknown,
  resumeRunId: string | undefined,
): TemplateLaunch | null {
  if (ref === undefined) return null;
  if (rawSpec !== undefined && rawSpec !== null)
    return { error: "'template' and 'spec' are mutually exclusive — pass one of them" };
  if (resumeRunId !== undefined)
    return {
      error:
        "'template' is not accepted with 'resume_run_id' — a resume replays the run's own spec and keeps its template",
    };
  if (loader === undefined)
    return { error: "no workflow template library is wired into this session" };
  let raw: unknown;
  try {
    raw = loader(ref);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), invalidSpec: true };
  }
  if (raw instanceof Promise) {
    // Never leave it dangling; a launch by template needs the spec now.
    void raw.catch(() => undefined);
    return { error: `template '${ref}' could not be loaded synchronously`, invalidSpec: true };
  }
  return { raw, origin: { ref, hash: templateHash(raw) } };
}

/** The origin a launch records: the template it was started from; on a
 * resume that replays its own spec, the origin it already had; on a resume
 * that sends a different spec, none — it no longer runs that template. */
export function launchOrigin(
  template: { readonly origin: RunTemplateOrigin } | null,
  explicitSpec: boolean,
  prior: { readonly template_ref: string | null; readonly template_hash: string | null } | null,
): RunTemplateOrigin | null {
  if (template !== null) return template.origin;
  if (explicitSpec || prior === null || prior.template_ref === null) return null;
  return { ref: prior.template_ref, hash: prior.template_hash ?? "" };
}
