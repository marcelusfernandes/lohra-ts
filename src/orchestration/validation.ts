import { toolError } from "../tools/envelope.js";
import type { ToolArguments } from "../tools/types.js";

function nonEmptyTrimmed(value: string): boolean {
  return value.trim().length > 0;
}

/** Coerces a non-string prompt via str(x).strip(), matching the oracle's coercion (L19). */
export function coercePrompt(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value).trim();
}

/**
 * spawn_session {"prompt": ""}/"   "/absent -> requires-non-empty-prompt.
 * A numeric prompt (e.g. 5) is accepted — coerced downstream via coercePrompt,
 * not rejected here (L19).
 */
export function validateSpawnPrompt(args: ToolArguments): string | null {
  const { prompt } = args;
  if (prompt === undefined || prompt === null) {
    return toolError("spawn_session requires a non-empty 'prompt'");
  }
  if (!nonEmptyTrimmed(coercePrompt(prompt))) {
    return toolError("spawn_session requires a non-empty 'prompt'");
  }
  return null;
}

/** steer_session requires both a sub_id and a non-empty text — one shared message for either gap. */
export function validateSteerArgs(args: ToolArguments): string | null {
  const { sub_id, text } = args;
  const hasSubId = typeof sub_id === "string" && sub_id.length > 0;
  const hasText = typeof text === "string" && nonEmptyTrimmed(text);
  if (!hasSubId || !hasText) {
    return toolError("steer_session requires 'sub_id' and a non-empty 'text'");
  }
  return null;
}

/** collect_session only validates presence here; numeric sub_id coercion happens at lookup. */
export function validateCollectSubId(args: ToolArguments): string | null {
  if (args.sub_id === undefined || args.sub_id === null) {
    return toolError("collect_session requires a 'sub_id'");
  }
  return null;
}

/** delegate_task {"tasks": "not a list"} -> ["not a list"], matching the oracle's coercion (L19). */
export function coerceTasks(value: unknown): readonly unknown[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value as readonly unknown[];
  return null;
}

export interface DelegateTasks {
  readonly tasks: readonly string[];
}

export function validateDelegateTasks(args: ToolArguments): DelegateTasks | string {
  const coerced = coerceTasks(args.tasks);
  if (coerced === null || coerced.length === 0) {
    return toolError("'tasks' must be a non-empty list of task descriptions");
  }
  for (const task of coerced) {
    if (typeof task !== "string" || !nonEmptyTrimmed(task)) {
      return toolError("each task must be a non-empty string");
    }
  }
  return { tasks: coerced as readonly string[] };
}

/**
 * L18: three distinct semantics under resume_id, none derivable from the
 * others — provider recused by truthiness ("" escapes and passes),
 * max_iterations refused by key presence (null included), model/effort
 * silently ignored (validated elsewhere, never rejected here).
 */
export function validateResumeOverrides(args: ToolArguments): string | null {
  if (args.resume_id === undefined) return null;
  if (args.provider) {
    return toolError("cannot switch provider when resuming a subagent");
  }
  if ("max_iterations" in args) {
    return toolError("cannot change max_iterations when resuming a subagent");
  }
  return null;
}

/** resume_id requires at least one non-empty follow-up instruction in tasks. */
export function validateResumeTasks(
  args: ToolArguments,
  tasks: readonly string[],
): string | null {
  if (args.resume_id === undefined) return null;
  if (!tasks.some(nonEmptyTrimmed)) {
    return toolError("resume_id requires a follow-up instruction in 'tasks'");
  }
  return null;
}

/**
 * L10: authored max_iterations bounds, three distinct messages for three
 * distinct classes of bad value — null is distinguished from absent, and
 * nothing is clamped.
 */
export function validateMaxIterations(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) {
    return toolError("'max_iterations' must be a whole number between 1 and 128, not null");
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return toolError("'max_iterations' must be a whole number between 1 and 128");
  }
  if (value < 1 || value > 128) {
    return toolError(`'max_iterations' must be between 1 and 128 (got ${String(value)})`);
  }
  return null;
}
