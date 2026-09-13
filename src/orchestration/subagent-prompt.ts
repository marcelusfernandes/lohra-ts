import {
  buildSystemPrompt,
  DEFAULT_IDENTITY,
  DOCTRINE_CORE,
  harnessText,
} from "../context/index.js";

/**
 * No memory/user-profile/skills sections, since a subagent has no access to
 * those stores. Issue #579 (épico #575, P3) added DOCTRINE_CORE as a fourth
 * static paragraph between this one and the date; issue #583 (P7) is this
 * paragraph's own return-contract clause — the previous text only said "end
 * with a concise summary", with no machine-readable form for the caller to
 * key off of (`buildSubagentPrompt`, `child-runner.ts`'s `outcome-
 * sentinel.ts`).
 */
const SUBAGENT_ISOLATION =
  "You are an isolated subagent spawned to complete one specific task. You " +
  "have no access to the parent conversation, its memory, or its skills, " +
  "and you cannot delegate further.";

/**
 * Issue #583: the tools list is derived from `childToolDefinitions` at the
 * call site (`chat-wiring.ts`), never hardcoded here — the anti-drift
 * guarantee is that this sentence and the turn's own `toolDefinitions`
 * (`child-runner.ts`) always come from the SAME filter over the SAME parent
 * catalog, so the two can never name a different set of tools.
 */
function toolsLine(toolNames: readonly string[]): string {
  const names = toolNames.length > 0 ? toolNames.join(", ") : "none";
  return (
    `Tools available to you: ${names} (plus any MCP tools listed in this ` +
    "turn's own tool array) — any other tool name is refused. Dangerous " +
    "commands (recursive delete, force push, sudo, and similar) are " +
    "refused automatically and finally here too, with no retry path around " +
    "the refusal."
  );
}

const TASK_BOUNDARY =
  "The task you were given is your boundary: if completing it needs " +
  "something outside that scope, stop and report the gap plainly instead " +
  "of improvising past it.";

const PARENT_CANNOT_SEE_OUTPUT =
  "The parent that spawned you never sees your raw tool output, only the " +
  "final text of this turn — restate whatever it needs to know in your " +
  "own words before you finish.";

/** Read back by `outcome-sentinel.ts` on the runner side — the three
 * literal prefixes there (`result:`, `failed:`, `needs input:`) have to stay
 * in sync with this sentence if either one ever changes. */
const RETURN_CONTRACT =
  "End your final message with exactly one line, and nothing after it: " +
  '"result: <summary>" once you finished the task, "failed: <why>" when ' +
  'you could not, or "needs input: <what>" when you are blocked on ' +
  "something only the parent can supply.";

function subagentContractText(toolNames: readonly string[]): string {
  return [toolsLine(toolNames), TASK_BOUNDARY, PARENT_CANNOT_SEE_OUTPUT, RETURN_CONTRACT].join(
    "\n\n",
  );
}

export interface SubagentPromptOverrides {
  readonly today?: string;
  /** Issue #583: the child's own working directory (`child-runner.ts`'s
   * `options.cwd`) — rendered as `buildSystemPrompt`'s `Environment:` block
   * so the child knows where it is without calling a tool to find out.
   * Omitted (no `Environment:` block at all) when absent, same
   * `filter(Boolean)` byte-compat pattern the rest of `buildSystemPrompt`
   * already follows. */
  readonly cwd?: string;
  /** Issue #583: the child's own tool names, in the order they'll actually
   * be offered (`childToolDefinitions(parentToolDefinitions)` at the call
   * site) — omitted (no tools/contract paragraphs at all) only for a caller
   * that passes nothing, which never happens in production. */
  readonly toolNames?: readonly string[];
}

/**
 * The subagent's system prompt text. Captured once at spawn by
 * OrchestrationCore's buildSubagentPrompt (decision 25) and reused verbatim
 * for every later turn of that child — this function itself has no memory of
 * past calls and must never be invoked again mid-session to "refresh" it.
 * No today override reuses buildSystemPrompt's own default so the pending
 * T09 UTC-vs-local-date fix on that shared file is inherited automatically
 * rather than duplicated here.
 */
export function buildSubagentSystemPrompt(overrides: SubagentPromptOverrides = {}): string {
  const toolNames = overrides.toolNames ?? [];
  return buildSystemPrompt({
    identity: `${DEFAULT_IDENTITY}\n\n${SUBAGENT_ISOLATION}`,
    // Issue #579 (épico #575, P3): sempre o núcleo universal, nunca a
    // extensão — este call site (`orchestration/chat-wiring.ts`) não tem o
    // perfil do provedor pai disponível para decidir a faixa
    // (`resolveDoctrineTier`), e essa fiação está fora dos `Files` desta
    // issue.
    doctrine: DOCTRINE_CORE,
    // Issue #580 (épico #575, P4): mode "subagent" — no user ever watches a
    // child's turn (`PromptMode` in `src/context/harness.ts`). `yolo`
    // deliberately stays absent/false here: `child.ts`'s own dangerous-
    // command gate (`createChildDispatch`) refuses unconditionally,
    // independent of the parent's `approval.ts` singleton
    // (`tests/tools-security-lifecycle.test.ts`, "keeps a dangerous child
    // command denied when the parent approval is yolo") — so `yolo: false`
    // here is not an understatement to fix, it is the true mechanism for a
    // subagent's own `terminal` calls.
    harness: harnessText({ mode: "subagent" }),
    ...(overrides.cwd === undefined ? {} : { environmentHints: { cwd: overrides.cwd } }),
    ...(toolNames.length === 0 ? {} : { systemMessage: subagentContractText(toolNames) }),
    ...(overrides.today === undefined ? {} : { today: overrides.today }),
  }).text;
}
