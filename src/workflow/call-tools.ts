// Issue #978 (épico #976 §6): the allow-list and the verdict of a model-free
// tool call (`ChildRuntime.callTool`, runtime.ts).
//
// The allow-list is the tools whose reach the operator's `workflow_policy.json`
// actually limits (`fs_allow` / `egress_allow`, sandbox.ts) AND that can be
// re-run without harm. Left out on purpose: `web_search` (the policy does not
// limit its destination), `write_file` (a side effect), `terminal` (with args
// from state it is a `code` node by another name), `mcp_*`, and everything in
// `CHILD_EXCLUDED_TOOLS`. The sandbox itself is NOT re-implemented here — a
// call goes through the very same wrap a leaf's call does
// (orchestration-runtime.ts); this module only decides which names may try.
import type { CallToolResult, CausalContext } from "./runtime.js";

export const CALL_TOOLS = Object.freeze(["read_file", "web_fetch"] as const);

export type CallToolName = (typeof CALL_TOOLS)[number];

/** Ceiling of one call's deadline, in seconds — a call is never unbounded
 * (CLAUDE.md invariant 3). */
export const MAX_CALL_TIMEOUT_SECONDS = 120;

export function isCallTool(name: string): name is CallToolName {
  return (CALL_TOOLS as readonly string[]).includes(name);
}

/** The deadline of one call, in milliseconds: the caller's seconds capped at
 * `MAX_CALL_TIMEOUT_SECONDS`. Zero, negative or non-finite does NOT mean "no
 * deadline" here (it does for a leaf's `collect`) — a call always has one, so
 * anything unusable falls to the ceiling. */
export function callDeadlineMs(timeoutSeconds: number): number {
  const seconds =
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.min(timeoutSeconds, MAX_CALL_TIMEOUT_SECONDS)
      : MAX_CALL_TIMEOUT_SECONDS;
  return seconds * 1000;
}

/** The identity a call has in the ledger and in the sandbox wrap: there is no
 * leaf, so there is no minted `sub_id` — it is derived from the calling cell
 * and attempt, which is unique per call (a retry is a new attempt). */
export function callSubId(causal: CausalContext): string {
  return `call:${causal.cellId}:${String(causal.attempt)}`;
}

/** The tool envelope's own verdict (`toolResult`, src/tools/envelope.ts, always
 * leads with `{"ok":true`) — the same rule `onToolSettled` uses for a leaf's
 * call, read from the prefix only, never by parsing the payload. */
export function isOkEnvelope(output: string): boolean {
  return output.startsWith('{"ok":true');
}

/**
 * Classifies a finished (non-timeout) call. `reached` is whether the call got
 * as far as the REAL base dispatch: a call that did not was turned away before
 * it — by the allow-list, the install, the stretch, the policy or the taint —
 * and is `denied` whatever text it carries; one that did is `ok` or `error`
 * by its own envelope. `output` is kept verbatim in every case.
 */
export function classifyCallOutput(reached: boolean, output: string): CallToolResult {
  if (!reached) return { status: "denied", output };
  return { status: isOkEnvelope(output) ? "ok" : "error", output };
}
