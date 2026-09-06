import { stringifyJsonPreservingNumbers } from "../../serialization/json-numbers.js";

// The tool dispatcher (src/tools/dispatch.ts) returns arguments/results as
// pre-serialized JSON *strings*, formatted however each tool happened to
// serialize them. docs/adr/0003-native-wire-format.md, "JSON output" item 1
// makes every JSON output in this runtime compact/insertion-order/UTF-8
// direct, so args_text/result and the outer frame's args field now share
// one format -- but args_text/result are still re-derived from the parsed
// structural value (not trusted as already-correct strings) for
// normalization: a tool's own JSON string may use different spacing or key
// order than `stringifyJsonPreservingNumbers` would.
function parseToolJson(raw: string): unknown {
  return JSON.parse(raw);
}

export interface ToolStartPayload {
  readonly tool_id: string;
  readonly name: string;
  readonly args_text: string;
}

export function buildToolStartPayload(input: {
  readonly toolId: string;
  readonly name: string;
  readonly argumentsJson: string;
}): ToolStartPayload {
  return {
    tool_id: input.toolId,
    name: input.name,
    args_text: stringifyJsonPreservingNumbers(parseToolJson(input.argumentsJson)),
  };
}

export interface ToolCompletePayload {
  readonly tool_id: string;
  readonly name: string;
  readonly args: unknown;
  readonly result: string;
}

export function buildToolCompletePayload(input: {
  readonly toolId: string;
  readonly name: string;
  readonly argumentsJson: string;
  readonly resultJson: string;
}): ToolCompletePayload {
  return {
    tool_id: input.toolId,
    name: input.name,
    args: parseToolJson(input.argumentsJson),
    result: stringifyJsonPreservingNumbers(parseToolJson(input.resultJson)),
  };
}
