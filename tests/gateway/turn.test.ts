import { describe, expect, it } from "vitest";

import {
  ConversationRuntime,
  type ConversationRepository,
  type ModelRequest,
  type ModelTransport,
} from "../../src/conversation/index.js";
import type { NormalizedResponse, ToolCall } from "../../src/transports/index.js";
import { ProviderCallFailed } from "../../src/transports/errors.js";
import { driveGatewayTurn, GatewayEventingToolDispatcher } from "../../src/gateway/turn.js";
import type { ToolCompletePayload, ToolStartPayload } from "../../src/gateway/rpc/tool-event-payload.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

class MemoryRepository implements ConversationRepository {
  private readonly sessions = new Map<string, { systemPrompt: string; model: string; cwd: string }>();
  public committed: unknown[] = [];

  createSession(input: { readonly id: string; readonly systemPrompt: string; readonly model: string; readonly cwd: string }): void {
    this.sessions.set(input.id, { systemPrompt: input.systemPrompt, model: input.model, cwd: input.cwd });
  }
  session(id: string) {
    return this.sessions.get(id) ?? null;
  }
  loadMessages() {
    return [];
  }
  commitTurn(commit: unknown): void {
    this.committed.push(commit);
  }
  commitUsage(): void {}
  summary() {
    return null;
  }
}

function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    content: "done",
    finishReason: "stop",
    toolCalls: [],
    reasoning: null,
    usage,
    providerData: null,
    ...overrides,
  };
}

describe("driveGatewayTurn: success path with streamed deltas", () => {
  it("threads onDelta through and returns {status:complete, text}", async () => {
    const repository = new MemoryRepository();
    repository.createSession({ id: "s1", systemPrompt: "p", model: "m", cwd: "/tmp" });
    class StreamingTransport implements ModelTransport {
      complete(request: ModelRequest): Promise<NormalizedResponse> {
        request.onText?.("hel");
        request.onText?.("lo");
        return Promise.resolve(response({ content: "hello" }));
      }
      close() {
        return Promise.resolve();
      }
    }
    const deltas: string[] = [];
    const outcome = await driveGatewayTurn({
      runtime: new ConversationRuntime({
        repository,
        transport: new StreamingTransport(),
        promptSnapshot: () => "p",
        idSource: () => "s1",
        clock: () => 1000,
      }),
      sessionId: "s1",
      text: "hi",
      provider: "p",
      model: "m",
      cwd: "/tmp",
      signal: new AbortController().signal,
      onDelta: (text) => deltas.push(text),
    });
    expect(deltas).toEqual(["hel", "lo"]);
    expect(outcome).toEqual({ status: "complete", text: "hello" });
  });
});

describe("driveGatewayTurn: interrupt (ConversationCancelledError -> {status:interrupted})", () => {
  it("returns interrupted when the signal aborts before the turn starts", async () => {
    class NeverCalledTransport implements ModelTransport {
      complete(): Promise<NormalizedResponse> {
        throw new Error("should never be called once already aborted");
      }
      close() {
        return Promise.resolve();
      }
    }
    const controller = new AbortController();
    controller.abort();
    const repository = new MemoryRepository();
    repository.createSession({ id: "s1", systemPrompt: "p", model: "m", cwd: "/tmp" });
    const outcome = await driveGatewayTurn({
      runtime: new ConversationRuntime({
        repository,
        transport: new NeverCalledTransport(),
        promptSnapshot: () => "p",
        idSource: () => "s1",
        clock: () => 1000,
      }),
      sessionId: "s1",
      text: "hi",
      provider: "p",
      model: "m",
      cwd: "/tmp",
      signal: controller.signal,
      onDelta: () => {},
    });
    expect(outcome).toEqual({ status: "interrupted" });
    expect(repository.committed).toHaveLength(0);
  });
});

describe("driveGatewayTurn: upstream error (L21/assertion 53 -- status + canary preserved)", () => {
  it("returns {status:error, warning} containing the upstream status and canary", async () => {
    class FailingTransport implements ModelTransport {
      complete(): Promise<NormalizedResponse> {
        return Promise.reject(
          new ProviderCallFailed("upstream refused", {
            statusCode: 418,
            payload: { error: { message: "T12_CAUSE_TEST_CANARY upstream refused" } },
          }),
        );
      }
      close() {
        return Promise.resolve();
      }
    }
    const repository = new MemoryRepository();
    repository.createSession({ id: "s1", systemPrompt: "p", model: "m", cwd: "/tmp" });
    const outcome = await driveGatewayTurn({
      runtime: new ConversationRuntime({
        repository,
        transport: new FailingTransport(),
        promptSnapshot: () => "p",
        idSource: () => "s1",
        clock: () => 1000,
      }),
      sessionId: "s1",
      text: "hi",
      provider: "p",
      model: "m",
      cwd: "/tmp",
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("expected error");
    expect(outcome.warning).toContain("418");
    expect(outcome.warning).toContain("T12_CAUSE_TEST_CANARY");
  });
});

describe("GatewayEventingToolDispatcher: tool.start/tool.complete emission and tool_id restart", () => {
  it("emits tool.start before dispatch and tool.complete after, tool_id starting at tool_1", async () => {
    const starts: ToolStartPayload[] = [];
    const completes: ToolCompletePayload[] = [];
    const rawDispatch = (_name: string, argumentsJson: string) =>
      Promise.resolve(
        JSON.stringify({ ok: true, echoed: JSON.parse(argumentsJson) as unknown }),
      );
    const dispatcher = new GatewayEventingToolDispatcher(rawDispatch, {
      onToolStart: (payload) => starts.push(payload),
      onToolComplete: (payload) => completes.push(payload),
    });
    const result = await dispatcher.dispatch({
      id: "call_1",
      name: "read_file",
      arguments: JSON.stringify({ path: "/tmp/x" }),
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]?.tool_id).toBe("tool_1");
    expect(starts[0]?.name).toBe("read_file");
    expect(completes).toHaveLength(1);
    expect(completes[0]?.tool_id).toBe("tool_1");
    expect(result).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      name: "read_file",
      content: JSON.stringify({ ok: true, echoed: { path: "/tmp/x" } }),
    });
  });

  it("restarts at tool_1 for a second call within the SAME dispatcher instance increments; a fresh instance restarts", async () => {
    const starts: ToolStartPayload[] = [];
    const rawDispatch = () => Promise.resolve("{}");
    const dispatcher = new GatewayEventingToolDispatcher(rawDispatch, {
      onToolStart: (payload) => starts.push(payload),
      onToolComplete: () => {},
    });
    await dispatcher.dispatch({ id: "1", name: "a", arguments: "{}" });
    await dispatcher.dispatch({ id: "2", name: "b", arguments: "{}" });
    expect(starts.map((s) => s.tool_id)).toEqual(["tool_1", "tool_2"]);

    const freshStarts: ToolStartPayload[] = [];
    const freshDispatcher = new GatewayEventingToolDispatcher(rawDispatch, {
      onToolStart: (payload) => freshStarts.push(payload),
      onToolComplete: () => {},
    });
    await freshDispatcher.dispatch({ id: "3", name: "c", arguments: "{}" });
    expect(freshStarts[0]?.tool_id).toBe("tool_1");
  });
});

describe("driveGatewayTurn: full turn with a tool call wired through GatewayEventingToolDispatcher", () => {
  it("runs a tool-calling iteration then completes, emitting tool.start/tool.complete in order", async () => {
    const events: string[] = [];
    class ToolCallingTransport implements ModelTransport {
      private calls = 0;
      complete(): Promise<NormalizedResponse> {
        this.calls += 1;
        if (this.calls === 1) {
          const toolCall: ToolCall = {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"/x"}',
            providerData: null,
          };
          return Promise.resolve(
            response({ content: null, finishReason: "tool_calls", toolCalls: [toolCall] }),
          );
        }
        return Promise.resolve(response({ content: "final answer" }));
      }
      close() {
        return Promise.resolve();
      }
    }
    const dispatcher = new GatewayEventingToolDispatcher(
      (name) => {
        events.push(`dispatch:${name}`);
        return Promise.resolve('{"ok":true}');
      },
      {
        onToolStart: (p) => events.push(`tool.start:${p.tool_id}`),
        onToolComplete: (p) => events.push(`tool.complete:${p.tool_id}`),
      },
    );
    const repository = new MemoryRepository();
    repository.createSession({ id: "s1", systemPrompt: "p", model: "m", cwd: "/tmp" });
    const outcome = await driveGatewayTurn({
      runtime: new ConversationRuntime({
        repository,
        transport: new ToolCallingTransport(),
        promptSnapshot: () => "p",
        toolDispatcher: dispatcher,
        toolDefinitions: [{ type: "function", function: { name: "read_file" } }],
        idSource: () => "s1",
        clock: () => 1000,
      }),
      sessionId: "s1",
      text: "hi",
      provider: "p",
      model: "m",
      cwd: "/tmp",
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(events).toEqual(["tool.start:tool_1", "dispatch:read_file", "tool.complete:tool_1"]);
    expect(outcome).toEqual({ status: "complete", text: "final answer" });
  });
});
