// A minimal OpenAI-chat-completions-shaped fake upstream for hermetic T12
// scenario testing, bound to an ephemeral port (never a fixed one -- this
// project already hit real false results from fixed-port contention
// between concurrently running sprint lanes; nothing here repeats that).
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

export interface FakeUpstream {
  readonly port: number;
  readonly requests: () => readonly { readonly path: string; readonly body: unknown }[];
  setNextContent(content: string): void;
  close(): Promise<void>;
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: { readonly path: string; readonly body: unknown }[] = [];
  let nextContent = "canned fake-upstream reply";

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsedBody: unknown;
      try {
        parsedBody = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        parsedBody = raw;
      }
      requests.push({ path: request.url ?? "", body: parsedBody });

      const payload = {
        id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
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
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => {
          resolvePromise();
        });
      }),
  };
}
