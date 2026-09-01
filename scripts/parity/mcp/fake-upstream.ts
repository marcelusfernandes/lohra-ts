import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const SUBAGENT_MARKER =
  "You are an isolated subagent spawned to complete one specific task.";

export interface UpstreamRecord {
  readonly sequence: number;
  readonly role: "parent" | "child";
  readonly body: Readonly<Record<string, unknown>>;
  readonly toolNames: readonly string[];
  readonly definitions: readonly unknown[];
}

export interface FakeUpstream {
  readonly baseUrl: string;
  readonly records: readonly UpstreamRecord[];
  close(): Promise<void>;
}

export interface FakeUpstreamOptions {
  readonly toolName?: string;
}

function messages(body: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const value = body["messages"];
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isChild(body: Readonly<Record<string, unknown>>): boolean {
  return messages(body).some(
    (message) => message["role"] === "system" && text(message["content"]).includes(SUBAGENT_MARKER),
  );
}

function scenario(body: Readonly<Record<string, unknown>>): string {
  for (const message of messages(body).toReversed()) {
    if (message["role"] !== "user") continue;
    const match = text(message["content"]).match(/SCEN:([A-Za-z0-9_-]+)/u);
    return match?.[1] ?? "ok";
  }
  return "ok";
}

function lastRole(body: Readonly<Record<string, unknown>>): string {
  return text(messages(body).at(-1)?.["role"]);
}

function json(response: ServerResponse, payload: unknown): void {
  const bytes = JSON.stringify(payload);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(bytes),
    connection: "close",
  });
  response.end(bytes);
}

function completion(content: string): Record<string, unknown> {
  return {
    id: "cmpl-t19",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "fake-model-a",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
}

function toolCall(name: string, args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "cmpl-t19",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "fake-model-a",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_t19_1",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
}

function lastToolContent(body: Readonly<Record<string, unknown>>): string {
  const tool = messages(body)
    .toReversed()
    .find((message) => message["role"] === "tool");
  return text(tool?.["content"]);
}

function handle(
  response: ServerResponse,
  body: Readonly<Record<string, unknown>>,
  options: FakeUpstreamOptions,
): void {
  if (isChild(body)) {
    json(response, completion("CHILD_DONE"));
    return;
  }
  const selected = scenario(body);
  const afterTool = lastRole(body) === "tool";
  if (selected === "delegate") {
    json(
      response,
      afterTool
        ? completion(`PARENT_SAW<${lastToolContent(body)}>`)
        : toolCall("delegate_task", { tasks: ["say hello from the subagent"] }),
    );
    return;
  }
  if (selected === "mcpcall") {
    json(
      response,
      afterTool
        ? completion(`MCPRESULT<${lastToolContent(body)}>`)
        : toolCall(options.toolName ?? "mcp_fix_echo", { text: "hello-mcp" }),
    );
    return;
  }
  json(response, completion("Hello gateway"));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolveListen(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

export async function startFakeUpstream(options: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const records: UpstreamRecord[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        const definitions = Array.isArray(body["tools"]) ? body["tools"] : [];
        const toolNames = definitions.map((entry) => {
          const fn = (entry as Record<string, unknown>)["function"] as
            Record<string, unknown> | undefined;
          return text(fn?.["name"]);
        });
        records.push({
          sequence: records.length + 1,
          role: isChild(body) ? "child" : "parent",
          body,
          toolNames,
          definitions,
        });
        handle(response, body, options);
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain", connection: "close" });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  let port = await listen(server);
  while ([11434, 9119, 8000].includes(port)) {
    await new Promise<void>((resolveClose) =>
      server.close(() => {
        resolveClose();
      }),
    );
    port = await listen(server);
  }
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    records,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolveClose();
        });
      }),
  };
}
