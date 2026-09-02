import { createServer, type Server, type Socket } from "node:net";

import {
  firstHeaderValue,
  parseHttpRequestHead,
  type ParsedRequestHead,
} from "./request-parser.js";
import { serializeHttpResponse, type OutgoingHttpResponse } from "./response.js";

export interface IncomingHttpRequest {
  readonly head: ParsedRequestHead;
  readonly body: Buffer;
}

export type RequestHandler = (request: IncomingHttpRequest) => Promise<OutgoingHttpResponse>;

// Invoked for a GET request carrying `Connection: Upgrade` / `Upgrade:
// websocket`. Receives the still-open raw socket plus any bytes already
// read past the header terminator (the RFC6455 "head" the ws library
// expects for handleUpgrade). The handler owns the socket from here on --
// this server never touches it again for that connection.
export type UpgradeHandler = (head: ParsedRequestHead, socket: Socket, extra: Buffer) => void;

function isUpgradeRequest(head: ParsedRequestHead): boolean {
  const connection = firstHeaderValue(head.headers, "Connection") ?? "";
  const upgrade = firstHeaderValue(head.headers, "Upgrade") ?? "";
  return /\bupgrade\b/iu.test(connection) && upgrade.toLowerCase() === "websocket";
}

function contentLength(head: ParsedRequestHead): number {
  const raw = firstHeaderValue(head.headers, "Content-Length");
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

class ConnectionState {
  private buffer = Buffer.alloc(0);
  private closed = false;

  public constructor(
    private readonly socket: Socket,
    private readonly onRequest: RequestHandler,
    private readonly onUpgrade: UpgradeHandler,
  ) {}

  public feed(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headBytes = this.buffer.subarray(0, headerEnd);
      let head: ParsedRequestHead;
      try {
        head = parseHttpRequestHead(Buffer.concat([headBytes, Buffer.from("\r\n\r\n")]));
      } catch {
        this.socket.destroy();
        return;
      }
      const bodyStart = headerEnd + 4;
      if (isUpgradeRequest(head)) {
        const remainder = this.buffer.subarray(bodyStart);
        this.buffer = Buffer.alloc(0);
        this.onUpgrade(head, this.socket, remainder);
        this.closed = true;
        return;
      }
      const length = contentLength(head);
      if (this.buffer.length < bodyStart + length) return; // wait for more bytes
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      const keepAlive =
        (firstHeaderValue(head.headers, "Connection") ?? "").toLowerCase() !== "close";
      this.dispatch({ head, body: Buffer.from(body) }, keepAlive);
    }
  }

  private dispatch(request: IncomingHttpRequest, keepAlive: boolean): void {
    this.onRequest(request)
      .then((response) => {
        if (this.closed || this.socket.destroyed) return;
        this.socket.write(serializeHttpResponse(response));
        if (keepAlive) this.drain();
        else this.socket.end();
      })
      .catch(() => {
        if (!this.socket.destroyed) this.socket.destroy();
      });
  }
}

export interface GatewayHttpServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

export async function startGatewayHttpServer(input: {
  readonly host: string;
  readonly port: number;
  readonly onRequest: RequestHandler;
  readonly onUpgrade: UpgradeHandler;
}): Promise<GatewayHttpServer> {
  const server = createServer((socket) => {
    const state = new ConnectionState(socket, input.onRequest, input.onUpgrade);
    socket.on("data", (chunk: Buffer) => {
      state.feed(chunk);
    });
    socket.on("error", () => {
      socket.destroy();
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host, () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : input.port;

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => {
          resolvePromise();
        });
      }),
  };
}
