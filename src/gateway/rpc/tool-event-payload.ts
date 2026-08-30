import { pythonJsonDumpsInsertionOrder } from "../../serialization/python-json.js";

// The tool dispatcher (src/tools/dispatch.ts) returns arguments/results as
// pre-serialized JSON *strings*, formatted however each tool happened to
// serialize them (plain JSON.stringify, typically compact and non-escaped).
// The gateway wire format requires a specific, different formatting for
// args_text/result (Python json.dumps default: spaced, ensure_ascii=True)
// and a specific formatting for args (compact, ensure_ascii=False, as part
// of the outer frame) -- so both are re-derived from the parsed structural
// value rather than trusted as already-correct strings.
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
    args_text: pythonJsonDumpsInsertionOrder(parseToolJson(input.argumentsJson)),
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
    result: pythonJsonDumpsInsertionOrder(parseToolJson(input.resultJson)),
  };
}
