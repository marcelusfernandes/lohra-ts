// A minimal OpenAI-chat-completions-shaped fake upstream for hermetic T12
// scenario testing, bound to an ephemeral port (never a fixed one -- this
// project already hit real false results from fixed-port contention
// between concurrently running sprint lanes; nothing here repeats that).
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

// A request whose stringified body contains this marker gets an upstream
// failure instead of a normal reply -- regardless of stream:true, since the
// real oracle/candidate both surface a pre-stream JSON error body even when
// streaming was requested (L21: the error never arrives as SSE). Content-
// triggered rather than call-ordered so two concurrent callers (a joint-gate
// scenario driving both `serve` and `dashboard` at once) can't race an
// "arm/consume" flag against each other.
export const UPSTREAM_FAILURE_NONCE = "T12_JOINT_GATE_UPSTREAM_FAILURE_NONCE";

export interface ToolCallScript {
  readonly toolName: string;
  readonly toolArguments: Record<string, unknown>;
}

// A request whose stringified body contains one of these markers gets a
// scripted tool_calls response instead of plain content -- UNLESS it's the
// follow-up call after the tool ran (detected by the last message in the
// conversation having role:"tool"), which gets the normal plain-content
// reply so the turn can finish. Argument shapes mirror this project's own
// existing unit-test fixtures for these exact tools (tests/gateway/
// tools.test.ts, tests/gateway/tool-event-payload.test.ts) so a triggered
// scenario exercises the SAME real tool-dispatch code paths those tests
// already proved work, just now driven end to end over a real socket
// against the real oracle too.
export const TOOL_CALL_TRIGGERS: Readonly<Record<string, ToolCallScript>> = {
  T12_TRIGGER_READ_FILE_NONASCII: {
    toolName: "read_file",
    toolArguments: { path: "/não-existe-ção" },
  },
  T12_TRIGGER_TERMINAL_SAFE: {
    toolName: "terminal",
    toolArguments: { command: "echo T12_TERMINAL_CANARY" },
  },
  T12_TRIGGER_TERMINAL_DANGER: {
    toolName: "terminal",
    toolArguments: { command: "rm -rf /tmp/whatever" },
  },
  T12_TRIGGER_MEMORY_LIST: { toolName: "memory", toolArguments: { action: "list" } },
};

function lastMessageRole(parsedBody: unknown): string | null {
  if (typeof parsedBody !== "object" || parsedBody === null) return null;
  const messages = (parsedBody as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as { role?: unknown };
  return typeof last.role === "string" ? last.role : null;
}

function matchedToolTrigger(raw: string): ToolCallScript | null {
  for (const [marker, script] of Object.entries(TOOL_CALL_TRIGGERS)) {
    if (raw.includes(marker)) return script;
  }
  return null;
}

export interface FakeUpstream {
  readonly port: number;
  readonly requests: () => readonly { readonly path: string; readonly body: unknown }[];
  setNextContent(content: string): void;
  /** Arms a one-shot hold: the NEXT streaming reply writes its initial
   * role-delta chunk, then blocks before sending any further chunks until
   * `release()` is called. Used to keep a turn deterministically "in
   * flight" long enough for a concurrent probe to observe busy state,
   * rather than relying on a timing race. */
  holdNextStream(): { release: () => void };
  close(): Promise<void>;
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: { readonly path: string; readonly body: unknown }[] = [];
  let nextContent = "canned fake-upstream reply";
  let pendingHold: { readonly promise: Promise<void>; readonly release: () => void } | null = null;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async (): Promise<void> => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsedBody: unknown;
        try {
          parsedBody = raw.length > 0 ? JSON.parse(raw) : null;
        } catch {
          parsedBody = raw;
        }
        requests.push({ path: request.url ?? "", body: parsedBody });

        if (raw.includes(UPSTREAM_FAILURE_NONCE)) {
          const failureBody = JSON.stringify({
            error: { message: `${UPSTREAM_FAILURE_NONCE} upstream refused`, type: "teapot_error" },
          });
          response.writeHead(418, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(failureBody)),
          });
          response.end(failureBody);
          return;
        }

        const wantsStream =
          typeof parsedBody === "object" &&
          parsedBody !== null &&
          (parsedBody as { stream?: unknown }).stream === true;
        const id = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
        const created = Math.floor(Date.now() / 1000);

        const toolScript = matchedToolTrigger(raw);
        const isToolFollowUp = lastMessageRole(parsedBody) === "tool";
        if (toolScript !== null && !isToolFollowUp) {
          const toolCall = {
            id: "call_1",
            type: "function",
            function: {
              name: toolScript.toolName,
              arguments: JSON.stringify(toolScript.toolArguments),
            },
          };
          if (wantsStream) {
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            const chunkOf = (delta: Record<string, unknown>, finishReason: string | null): string =>
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: "fake-model-a",
                choices: [{ index: 0, delta, finish_reason: finishReason }],
              })}\n\n`;
            response.write(chunkOf({ role: "assistant" }, null));
            response.write(chunkOf({ tool_calls: [{ index: 0, ...toolCall }] }, null));
            response.write(chunkOf({}, "tool_calls"));
            response.write("data: [DONE]\n\n");
            response.end();
            return;
          }
          const payload = {
            id,
            object: "chat.completion",
            created,
            model: "fake-model-a",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: null, tool_calls: [toolCall] },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
          const body = JSON.stringify(payload);
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          });
          response.end(body);
          return;
        }

        if (wantsStream) {
          // Real chat_completions clients that request stream:true expect
          // SSE chunks, not a single JSON blob -- both the oracle and this
          // session's candidate stream by default when driving a real turn
          // (dashboard.ts's per-turn transport factory), so this is not
          // optional for any prompt.submit-dependent scenario.
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const chunkOf = (delta: Record<string, unknown>, finishReason: string | null): string =>
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: "fake-model-a",
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            })}\n\n`;
          response.write(chunkOf({ role: "assistant" }, null));
          if (pendingHold !== null) {
            const hold = pendingHold;
            pendingHold = null;
            await hold.promise;
          }
          for (const word of nextContent.length > 0 ? nextContent.split(" ") : []) {
            response.write(chunkOf({ content: `${word} ` }, null));
          }
          response.write(chunkOf({}, "stop"));
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }

        const payload = {
          id,
          object: "chat.completion",
          created,
          model: "fake-model-a",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: nextContent },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        const body = JSON.stringify(payload);
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
      })();
    });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    requests: () => requests,
    setNextContent(content: string): void {
      nextContent = content;
    },
    holdNextStream(): { release: () => void } {
      let releaseFn: () => void = () => {};
      const promise = new Promise<void>((resolveHold) => {
        releaseFn = resolveHold;
      });
      pendingHold = { promise, release: releaseFn };
      return { release: releaseFn };
    },
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => {
          resolvePromise();
        });
      }),
  };
}
