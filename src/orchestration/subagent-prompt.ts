import { buildSystemPrompt, DEFAULT_IDENTITY } from "../context/index.js";

/**
 * Byte-measured against evidence-s01-child-real.json's child_system_full
 * (and confirmed unchanged across an idle-steer resurrection by
 * evidence-s02-steer.json) — three static paragraphs, no memory/user-profile/
 * skills sections, since a subagent has no access to those stores.
 */
const SUBAGENT_ISOLATION =
  "You are an isolated subagent spawned to complete one specific task. You " +
  "have no access to the parent conversation, its memory, or its skills, " +
  "and you cannot delegate further. Use the available tools to complete " +
  "the task, then end with a concise summary of what you did and the " +
  "outcome.";

/**
 * The subagent's system prompt text. Captured once at spawn by
 * OrchestrationCore's buildSubagentPrompt (decision 25) and reused verbatim
 * for every later turn of that child — this function itself has no memory of
 * past calls and must never be invoked again mid-session to "refresh" it.
 * No today override reuses buildSystemPrompt's own default so the pending
 * T09 UTC-vs-local-date fix on that shared file is inherited automatically
 * rather than duplicated here.
 */
export function buildSubagentSystemPrompt(overrides: { readonly today?: string } = {}): string {
  return buildSystemPrompt({
    identity: `${DEFAULT_IDENTITY}\n\n${SUBAGENT_ISOLATION}`,
    ...(overrides.today === undefined ? {} : { today: overrides.today }),
  }).text;
}
