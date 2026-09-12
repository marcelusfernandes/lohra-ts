// Issue #464 (M11-S6, épico #458): the operator's on-disk workflow template
// library — one JSON spec per `<home>/workflows/<ref>.json`, `ref` = the
// filename without its `.json` extension. Ties BOTH a nested
// `{type: "workflow", ref}` node (`schema.ts`'s `validateNestedRefs`,
// `engine.ts`'s `runNested`) and the `workflow_templates` tool to the SAME
// directory. Before this issue neither had a loader wired in production
// (`chat.ts`/`dashboard.ts` never passed one), and `workflow_templates` was
// a `failSafe` stub (`builtins.ts:34`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";
import type { WorkflowLoader } from "./engine-contract.js";
import { validateSpec } from "./schema.js";
import { isValidationError } from "./types.js";

/** The operator's template library, a directory name relative to `home` —
 * the same root `workflow_tiers.json`/`workflow_policy.json` are already
 * read from (`service.ts:420-423`). */
export const OPERATOR_TEMPLATES_DIR = "workflows";

/** Fail-closed `ref` shape: lowercase letters/digits/`_`/`-`, 1-64 chars,
 * starting alphanumeric. No path separator, no `..` — a `ref` can never
 * escape `OPERATOR_TEMPLATES_DIR`. */
export const TEMPLATE_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Named, fail-closed error for a `ref` this loader refuses or a file it
 * cannot trust — cites the `ref` and, in `cause`, the underlying failure
 * (same shape as `TiersError`, `tiers.ts`, #234). `validateNestedRefs`
 * (`schema.ts:766-800`) catches this at launch; `runNested`'s backstop
 * (`engine.ts:832-848`) does the same at execution time. */
export class TemplateError extends Error {
  readonly ref: string;

  constructor(ref: string, reason: string, cause?: unknown) {
    super(`template '${ref}' ${reason}`, { cause });
    this.name = "TemplateError";
    this.ref = ref;
  }
}

function templatePath(home: string, ref: string): string {
  return join(home, OPERATOR_TEMPLATES_DIR, `${ref}.json`);
}

/** Same distinction `tiers.ts:40-46` makes: absent vs unreadable. */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Reads and parses one template file — `templateLoader`/`listTemplates`
 * share the same fail-closed reason for the same broken file. */
function readTemplateFile(path: string, ref: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new TemplateError(
      ref,
      isEnoent(error) ? `not found at ${path}` : `at ${path} could not be read`,
      error,
    );
  }
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new TemplateError(ref, `at ${path} is not valid JSON`, error);
  }
}

/** Synchronous `WorkflowLoader` reading `<home>/workflows/<ref>.json` — the
 * loader `chat.ts`/`dashboard.ts` wire into `WorkflowService`, reused by
 * `workflowTemplatesHandler` (below) for `{name}`. A `ref` outside
 * `TEMPLATE_REF`'s shape is refused before touching the filesystem. */
export function templateLoader(home: string): WorkflowLoader {
  return (ref: string): unknown => {
    if (!TEMPLATE_REF.test(ref)) {
      throw new TemplateError(ref, "has an invalid ref format (expected [a-z0-9][a-z0-9_-]{0,63})");
    }
    return readTemplateFile(templatePath(home, ref), ref);
  };
}

export interface TemplateListing {
  readonly ref: string;
  readonly name?: string;
  readonly nodes?: number;
  readonly error?: string;
}

/** Directory listing of every `.json` under `<home>/workflows/` — fail-closed
 * per entry: a broken file never drops silently, it surfaces as
 * `{ref, error}`. An absent directory is a legitimate empty library, not an
 * error (mirrors `readTiers`'s `ENOENT` → `{}`, #234). */
export function listTemplates(home: string): readonly TemplateListing[] {
  const dir = join(home, OPERATOR_TEMPLATES_DIR);
  if (!existsSync(dir)) return Object.freeze([]);
  const entries: TemplateListing[] = [];
  for (const fileName of readdirSync(dir).sort()) {
    if (!fileName.endsWith(".json")) continue;
    const ref = basename(fileName, ".json");
    // Fail-closed like `templateLoader`: a filename whose stem is not a
    // valid `ref` could never be resolved through a nested node either.
    if (!TEMPLATE_REF.test(ref)) {
      entries.push({ ref, error: "filename is not a valid ref ([a-z0-9][a-z0-9_-]{0,63})" });
      continue;
    }
    try {
      const raw = readTemplateFile(join(dir, fileName), ref);
      const spec = validateSpec(raw);
      if (isValidationError(spec)) {
        entries.push({ ref, error: spec.message });
        continue;
      }
      entries.push({ ref, name: spec.name, nodes: spec.nodes.length });
    } catch (error) {
      entries.push({ ref, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return Object.freeze(entries);
}

/** `workflow_templates` tool: no `name` lists (`listTemplates`); `name`
 * loads and VALIDATES that one template first — invalid cites the issues
 * instead of ever returning a broken file. Issue #484: the envelope's own
 * `spec` is still the file's raw JSON, not the normalized `WorkflowSpec`
 * `validateSpec` returns — `WorkflowSpec` is an internal class (`nodes` as
 * `Node` instances, `fields` nested one level down) the caller (typically
 * the model, adapting a template to resubmit as `run_workflow`'s own
 * `spec`) could never pass back as-is; `raw` is the one shape that
 * round-trips. Validation still runs, and still refuses before either
 * shape ever leaves this function — "validated" describes the CHECK, not
 * the shape returned. */
export function workflowTemplatesHandler(home: string): ToolHandler {
  return (args: ToolArguments): string => {
    const name = args.name;
    if (name === undefined) return toolResult(undefined, { templates: listTemplates(home) });
    if (typeof name !== "string" || name === "")
      return toolError("'name' must be a non-empty string");
    let raw: unknown;
    try {
      raw = templateLoader(home)(name);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
    const spec = validateSpec(raw);
    if (isValidationError(spec)) return toolError(`invalid template '${name}': ${spec.message}`);
    return toolResult(undefined, { ref: name, spec: raw });
  };
}
