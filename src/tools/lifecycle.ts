import { pythonJsonDumpsInsertionOrder } from "../serialization/python-json.js";
import type { RegistryDispatch, ToolArguments } from "./types.js";

export interface ToolStartEvent {
  readonly type: "tool.start";
  readonly payload: {
    readonly tool_id: string;
    readonly name: string;
    readonly args_text: string;
  };
}

export interface ToolCompleteEvent {
  readonly type: "tool.complete";
  readonly payload: {
    readonly tool_id: string;
    readonly name: string;
    readonly args: ToolArguments;
    readonly result: string;
  };
}

export type ToolLifecycleEvent = ToolStartEvent | ToolCompleteEvent;
export type ToolLifecycleSink = (event: ToolLifecycleEvent) => void;

export function wrapToolDispatch(
  base: RegistryDispatch,
  sink: ToolLifecycleSink,
): (name: string, args: ToolArguments) => Promise<string> {
  let nextId = 1;
  return async (name, args) => {
    const toolId = `tool_${String(nextId)}`;
    nextId += 1;
    sink({
      type: "tool.start",
      payload: {
        tool_id: toolId,
        name,
        args_text: pythonJsonDumpsInsertionOrder(args),
      },
    });
    const result = await base(name, args);
    sink({
      type: "tool.complete",
      payload: { tool_id: toolId, name, args: structuredClone(args), result },
    });
    return result;
  };
}
