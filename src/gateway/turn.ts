import { ConversationCancelledError } from "../conversation/errors.js";
import type { ConversationRuntime } from "../conversation/runtime.js";
import type { ToolDispatcher } from "../conversation/types.js";
import { publicCauseMessage } from "../transports/index.js";
import {
  buildToolCompletePayload,
  buildToolStartPayload,
  type ToolCompletePayload,
  type ToolStartPayload,
} from "./rpc/tool-event-payload.js";
import { GatewayToolIdCounter } from "./tools.js";

export interface TurnSink {
  readonly onToolStart: (payload: ToolStartPayload) => void;
  readonly onToolComplete: (payload: ToolCompletePayload) => void;
}

// Wraps a raw (name, argsJson) => Promise<string> dispatcher (from
// GatewayToolRuntime) with tool.start/tool.complete event emission, and a
// fresh tool_id counter per instance -- construct one per turn so
// tool_id restarts at tool_1 every turn (assertion 38), never persists
// across turns.
export class GatewayEventingToolDispatcher implements ToolDispatcher {
  private readonly counter = new GatewayToolIdCounter();

  public constructor(
    private readonly rawDispatch: (name: string, argumentsJson: string) => Promise<string>,
    private readonly sink: TurnSink,
  ) {}

  public async dispatch(call: {
    readonly id: string | null;
    readonly name: string;
    readonly arguments: string;
  }): Promise<Readonly<Record<string, unknown>>> {
    const toolId = this.counter.nextId();
    this.sink.onToolStart(
      buildToolStartPayload({ toolId, name: call.name, argumentsJson: call.arguments }),
    );
    const content = await this.rawDispatch(call.name, call.arguments);
    this.sink.onToolComplete(
      buildToolCompletePayload({
        toolId,
        name: call.name,
        argumentsJson: call.arguments,
        resultJson: content,
      }),
    );
    return Object.freeze({ role: "tool", tool_call_id: call.id, name: call.name, content });
  }
}

export type TurnOutcome =
  | { readonly status: "complete"; readonly text: string }
  | { readonly status: "interrupted" }
  | { readonly status: "error"; readonly warning: string };

// Drives exactly one turn through ConversationRuntime.runTurn, translating
// its outcomes into the gateway's observable vocabulary:
// ConversationCancelledError (thrown when the AbortSignal fires -- see
// GatewaySessionRegistry.interrupt) becomes {status:"interrupted"}, any
// other failure becomes {status:"error", warning} with the causal
// status/canary preserved via the same publicCauseMessage() chat.ts and
// server/service.ts already use (L21/assertion 53) -- never a raw thrown
// exception, and never silently swallowed.
export async function driveGatewayTurn(input: {
  readonly runtime: ConversationRuntime;
  readonly sessionId: string;
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly onDelta: (text: string) => void;
}): Promise<TurnOutcome> {
  try {
    const result = await input.runtime.runTurn({
      input: input.text,
      provider: input.provider,
      model: input.model,
      cwd: input.cwd,
      sessionId: input.sessionId,
      signal: input.signal,
      onDelta: input.onDelta,
    });
    return { status: "complete", text: result.response.content ?? "" };
  } catch (error) {
    if (error instanceof ConversationCancelledError) return { status: "interrupted" };
    return { status: "error", warning: publicCauseMessage(error) };
  }
}
