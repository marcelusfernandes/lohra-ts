// Issue #978 (épico #976 §6): the allow-list and the verdict of a model-free
// tool call. STUB — red phase.
import type { CallToolResult, CausalContext } from "./runtime.js";

export const CALL_TOOLS = Object.freeze(["read_file", "web_fetch"] as const);

export type CallToolName = (typeof CALL_TOOLS)[number];

export const MAX_CALL_TIMEOUT_SECONDS = 120;

export function isCallTool(_name: string): _name is CallToolName {
  throw new Error("not implemented: isCallTool");
}

export function callDeadlineMs(_timeoutSeconds: number): number {
  throw new Error("not implemented: callDeadlineMs");
}

export function callSubId(_causal: CausalContext): string {
  throw new Error("not implemented: callSubId");
}

export function isOkEnvelope(_output: string): boolean {
  throw new Error("not implemented: isOkEnvelope");
}

export function classifyCallOutput(_reached: boolean, _output: string): CallToolResult {
  throw new Error("not implemented: classifyCallOutput");
}
