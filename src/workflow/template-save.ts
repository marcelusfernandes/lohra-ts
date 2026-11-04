// Issue #970 (épico #969): `workflow_save` — the orchestrator keeps a
// workflow it authored and ran to `complete` as a template in the SAME
// `<home>/workflows/<ref>.json` library `templateLoader`/`listTemplates`
// (`templates.ts`) already read, so a nested `{type: "workflow", ref}` node
// and `workflow_templates` see it with no other change. Before this issue
// only the operator wrote that directory, by hand.
//
// Limits (CLAUDE.md invariants 2-4): every refusal is a named error and
// nothing touches the disk before all of them pass; the saved spec goes
// through the same `validateSpec`/`validateNestedRefs` a `run_workflow`
// launch does, so no path around the caps; the agent's share of the library
// is capped; and a file is created ONCE, atomically, never rewritten — a
// new version is a new `ref` — so there is no shared mutable state for two
// processes to race on (the exclusive `link` is the lock).
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";
import type { WorkflowLoader } from "./engine-contract.js";
import { validateNestedRefs, validateSpec } from "./schema.js";
import { AGENT_ORIGIN, OPERATOR_TEMPLATES_DIR, TEMPLATE_REF } from "./templates.js";
import { isValidationError } from "./types.js";

/** How many templates the agent itself may hold in the library — invariant
 * 3: the library is listed whole on every `workflow_templates` call. */
export const MAX_AGENT_TEMPLATES = 100;
/** Serialized size cap for one saved template (same order as
 * `MAX_SKILL_BYTES`, `src/skills/store.ts:8`). */
export const MAX_TEMPLATE_BYTES = 256_000;
/** Same limit as a skill description (`src/skills/store.ts:7`). */
export const MAX_TEMPLATE_DESCRIPTION = 1024;

/** What `workflow_save` needs to know about a run — `WorkflowService.durableRun`
 * in production, a fake in unit tests. */
export interface SavableRun {
  readonly status: string;
  readonly spec: Readonly<Record<string, unknown>> | null;
}

export type SavableRunLookup = (runId: string) => SavableRun | null;

export interface SaveTemplateRequest {
  readonly runId: string;
  readonly ref: string;
  readonly description: string;
}

export interface SavedTemplate {
  readonly ref: string;
  readonly path: string;
  readonly name: string;
  readonly nodes: number;
  readonly warning?: string;
}

/** Named, fail-closed refusal — the message is what the model reads. */
export class TemplateSaveError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "TemplateSaveError";
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/** Templates in `dir` whose `meta.origin.by` is the agent's. A file that
 * cannot be READ refuses the save (it might be the agent's, and the cap must
 * never under-count silently); a file that is not valid JSON is never an
 * agent save (saves are validated and atomic) and already surfaces as
 * `{ref, error}` in `listTemplates`. Two concurrent saves at the cap can
 * still land one over it — bounded, since each needs its own complete run. */
export function countAgentTemplates(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw new TemplateSaveError(`template library at ${dir} could not be read`, error);
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let content: string;
    try {
      content = readFileSync(join(dir, name), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue; // removed since the listing
      throw new TemplateSaveError(
        `template library entry ${join(dir, name)} could not be read — the ${String(MAX_AGENT_TEMPLATES)}-template cap cannot be checked`,
        error,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content) as unknown;
    } catch {
      continue; // not valid JSON: never an agent save (see above)
    }
    const origin = record(record(record(raw)?.meta)?.origin);
    if (origin?.by === AGENT_ORIGIN) count += 1;
  }
  return count;
}

/** Publishes `content` as `<dir>/<ref>.json` only if that name is free:
 * written to a temporary file in the same directory, then hard-linked into
 * place — `link` fails with `EEXIST` instead of replacing, atomically, so of
 * two concurrent saves of one `ref` exactly one wins. The temporary file is
 * removed on every path; a failed removal is reported, never swallowed. */
export function publishTemplateFile(
  dir: string,
  ref: string,
  content: string,
): { readonly path: string; readonly warning?: string } {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${ref}.json`);
  const temporary = join(dir, `.${ref}.${randomUUID()}.tmp`);
  let published: unknown = null;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    linkSync(temporary, target);
  } catch (error) {
    published = error;
  }
  let warning: string | undefined;
  try {
    unlinkSync(temporary);
  } catch (error) {
    // ENOENT: the write itself failed before creating it — nothing to remove.
    if (errorCode(error) !== "ENOENT")
      warning = `temporary file ${temporary} could not be removed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (published !== null) {
    if (errorCode(published) === "EEXIST")
      throw new TemplateSaveError(`template '${ref}' already exists — save under a new ref`);
    throw new TemplateSaveError(`template '${ref}' could not be written at ${target}`, published);
  }
  return warning === undefined ? { path: target } : { path: target, warning };
}

/** The whole save: every refusal before the disk is touched, then one
 * atomic, no-clobber publish. */
export function saveTemplate(
  home: string,
  lookup: SavableRunLookup,
  loader: WorkflowLoader | undefined,
  request: SaveTemplateRequest,
  now: () => Date = () => new Date(),
): SavedTemplate {
  const { runId, ref } = request;
  const description = request.description.trim();
  if (!TEMPLATE_REF.test(ref))
    throw new TemplateSaveError(
      `invalid ref '${ref}' (expected [a-z0-9][a-z0-9_-]{0,63}, the template's filename)`,
    );
  if (description === "")
    throw new TemplateSaveError("'description' must say what the workflow is for");
  if (description.length > MAX_TEMPLATE_DESCRIPTION)
    throw new TemplateSaveError(
      `'description' is over ${String(MAX_TEMPLATE_DESCRIPTION)} characters`,
    );
  const run = lookup(runId);
  if (run === null) throw new TemplateSaveError(`unknown workflow run '${runId}'`);
  if (run.status !== "complete")
    throw new TemplateSaveError(
      `workflow run '${runId}' is '${run.status}' — only a 'complete' run can be saved as a template`,
    );
  if (run.spec === null) throw new TemplateSaveError(`no spec on file for workflow run '${runId}'`);
  const meta = record(run.spec.meta) ?? {};
  const template = {
    ...run.spec,
    meta: {
      ...meta,
      description,
      origin: { by: AGENT_ORIGIN, run_id: runId, saved_at: now().toISOString() },
    },
  };
  const parsed = validateSpec(template);
  if (isValidationError(parsed))
    throw new TemplateSaveError(`run '${runId}' spec is not a valid template: ${parsed.message}`);
  const nested = validateNestedRefs(parsed, loader);
  if (nested !== null)
    throw new TemplateSaveError(`run '${runId}' spec is not a valid template: ${nested.message}`);
  const content = `${JSON.stringify(template, null, 2)}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_TEMPLATE_BYTES)
    throw new TemplateSaveError(
      `template '${ref}' is ${String(bytes)} bytes, over the ${String(MAX_TEMPLATE_BYTES)}-byte cap`,
    );
  const dir = join(home, OPERATOR_TEMPLATES_DIR);
  const agentCount = countAgentTemplates(dir);
  if (agentCount >= MAX_AGENT_TEMPLATES)
    throw new TemplateSaveError(
      `the library already holds ${String(agentCount)} agent-saved templates (cap ${String(MAX_AGENT_TEMPLATES)}) — reuse one instead`,
    );
  const published = publishTemplateFile(dir, ref, content);
  return {
    ref,
    path: published.path,
    name: parsed.name,
    nodes: parsed.nodes.length,
    ...(published.warning === undefined ? {} : { warning: published.warning }),
  };
}

/** `workflow_save` tool: `{run_id, ref, description}`. */
export function workflowSaveHandler(
  home: string,
  lookup: SavableRunLookup,
  loader: WorkflowLoader | undefined,
  now?: () => Date,
): ToolHandler {
  return (args: ToolArguments): string => {
    const { run_id: runId, ref, description } = args;
    if (typeof runId !== "string" || runId === "")
      return toolError("workflow_save requires 'run_id' (a complete run)");
    if (typeof ref !== "string" || ref === "")
      return toolError("workflow_save requires 'ref' (the new template's name)");
    if (typeof description !== "string")
      return toolError("workflow_save requires 'description' (what the workflow is for)");
    try {
      const saved = saveTemplate(home, lookup, loader, { runId, ref, description }, now);
      return toolResult(undefined, { saved: true, ...saved });
    } catch (error) {
      if (error instanceof TemplateSaveError) return toolError(error.message);
      return toolError(
        `template '${ref}' could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
