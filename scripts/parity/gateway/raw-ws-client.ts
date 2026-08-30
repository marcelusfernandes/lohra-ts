// A hand-rolled RFC6455 WebSocket client for the T12 parity harness. This
// is the literal requirement behind contract assertion 67: the ws library
// (used by src/gateway/ws/connection.ts's SERVER side, and by this
// project's own internal TDD tests per assertion 67's carve-out) is
// explicitly banned as principal evidence for handshake facts -- status
// line, close code, reason, frame opcode/FIN/length -- because a
// high-level client can silently paper over exactly the wire-level
// behavior this ticket exists to prove (e.g. "does the handshake respond
// 101 even when auth is about to fail with 4401?", which a client that
// treats auth failure as a connection error rather than a close frame
// could get wrong).
import { randomBytes, createHash } from "node:crypto";
import { connect, type Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface RawWsHandshakeResult {
  readonly statusLine: string;
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
}

export interface RawWsFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

export const WS_OPCODE = {
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

function computeAccept(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const maskKey = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = (payload[i] as number) ^ (maskKey[i % 4] as number);
  }
  let lengthBytes: Buffer;
  if (payload.length < 126) {
    lengthBytes = Buffer.from([0x80 | payload.length]);
  } else if (payload.length < 65536) {
    lengthBytes = Buffer.alloc(3);
    lengthBytes[0] = 0x80 | 126;
    lengthBytes.writeUInt16BE(payload.length, 1);
  } else {
    lengthBytes = Buffer.alloc(9);
    lengthBytes[0] = 0x80 | 127;
    lengthBytes.writeBigUInt64BE(BigInt(payload.length), 1);
  }
  const firstByte = Buffer.from([0x80 | opcode]); // FIN=1, RSV=0
  return Buffer.concat([firstByte, lengthBytes, maskKey, masked]);
}

// A minimal, single-connection frame stream: feed it raw bytes as they
// arrive, and it hands back complete frames as soon as each one is fully
// buffered. Server frames are not required to be masked (and this
// gateway's server never masks them), but decoding honors the mask bit
// either way for correctness.
class FrameDecoder {
  private buffer = Buffer.alloc(0);

  public feed(chunk: Buffer): RawWsFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: RawWsFrame[] = [];
    for (;;) {
      const frame = this.tryDecodeOne();
      if (frame === null) break;
      frames.push(frame);
    }
    return frames;
  }

  private tryDecodeOne(): RawWsFrame | null {
    if (this.buffer.length < 2) return null;
    const firstByte = this.buffer[0] as number;
    const secondByte = this.buffer[1] as number;
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let lengthFieldSize = 1;
    let payloadLength = secondByte & 0x7f;
    if (payloadLength === 126) {
      if (this.buffer.length < 4) return null;
      payloadLength = this.buffer.readUInt16BE(2);
      lengthFieldSize = 3;
    } else if (payloadLength === 127) {
      if (this.buffer.length < 10) return null;
      payloadLength = Number(this.buffer.readBigUInt64BE(2));
      lengthFieldSize = 9;
    }
    const maskSize = masked ? 4 : 0;
    const headerSize = 1 + lengthFieldSize + maskSize;
    const totalSize = headerSize + payloadLength;
    if (this.buffer.length < totalSize) return null;

    let payload = this.buffer.subarray(headerSize, totalSize);
    if (masked) {
      const maskKey = this.buffer.subarray(headerSize - 4, headerSize);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        unmasked[i] = (payload[i] as number) ^ (maskKey[i % 4] as number);
      }
      payload = unmasked;
    }
    this.buffer = this.buffer.subarray(totalSize);
    return { fin, opcode, payload: Buffer.from(payload) };
  }
}

export interface RawWsClient {
  readonly handshake: RawWsHandshakeResult;
  sendText(text: string): void;
  sendBinary(payload: Buffer): void;
  nextFrame(timeoutMs?: number): Promise<RawWsFrame>;
  close(): void;
}

// Connects, sends a hand-built RFC6455 upgrade request, and parses the raw
// response bytes -- the handshake completing (or not) is itself part of
// what several scenarios assert on, so this never uses node:http's Upgrade
// event or any client library's automatic handshake handling.
export async function connectRawWs(
  host: string,
  port: number,
  path: string,
  extraHeaders: readonly (readonly [string, string])[] = [],
  timeoutMs = 5000,
): Promise<RawWsClient> {
  const key = randomBytes(16).toString("base64");
  const socket: Socket = connect(port, host);

  const handshake = await new Promise<{ result: RawWsHandshakeResult; rest: Buffer }>(
    (resolvePromise, reject) => {
      let buffer = Buffer.alloc(0);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`RAW_WS_HANDSHAKE_TIMEOUT after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      socket.on("connect", () => {
        const headerLines = [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${String(port)}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          ...extraHeaders.map(([name, value]) => `${name}: ${value}`),
        ];
        socket.write(`${headerLines.join("\r\n")}\r\n\r\n`, "binary");
      });

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        clearTimeout(timeout);
        const head = buffer.subarray(0, headerEnd).toString("binary");
        const lines = head.split("\r\n");
        const statusLine = lines[0] ?? "";
        const match = /^HTTP\/\d\.\d (\d{3})/u.exec(statusLine);
        const status = match ? Number(match[1]) : 0;
        const headers: (readonly [string, string])[] = [];
        for (const line of lines.slice(1)) {
          const separator = line.indexOf(":");
          if (separator < 0) continue;
          headers.push([line.slice(0, separator), line.slice(separator + 1).replace(/^ /u, "")]);
        }
        resolvePromise({
          result: { statusLine, status, headers },
          rest: buffer.subarray(headerEnd + 4),
        });
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    },
  );

  if (handshake.result.status === 101) {
    const acceptHeader = handshake.result.headers.find(
      ([name]) => name.toLowerCase() === "sec-websocket-accept",
    )?.[1];
    const expected = computeAccept(key);
    if (acceptHeader !== expected) {
      socket.destroy();
      throw new Error(
        `RAW_WS_ACCEPT_MISMATCH expected=${expected} got=${String(acceptHeader)}`,
      );
    }
  }

  const decoder = new FrameDecoder();
  const pendingFrames: RawWsFrame[] = decoder.feed(handshake.rest);
  const waiters: ((frame: RawWsFrame) => void)[] = [];

  socket.on("data", (chunk: Buffer) => {
    const frames = decoder.feed(chunk);
    for (const frame of frames) {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else pendingFrames.push(frame);
    }
  });

  return {
    handshake: handshake.result,
    sendText(text: string): void {
      socket.write(encodeClientFrame(WS_OPCODE.text, Buffer.from(text, "utf8")));
    },
    sendBinary(payload: Buffer): void {
      socket.write(encodeClientFrame(WS_OPCODE.binary, payload));
    },
    nextFrame(frameTimeoutMs = timeoutMs): Promise<RawWsFrame> {
      const queued = pendingFrames.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`RAW_WS_NEXT_FRAME_TIMEOUT after ${String(frameTimeoutMs)}ms`));
        }, frameTimeoutMs);
        waiters.push((frame) => {
          clearTimeout(timeout);
          resolvePromise(frame);
        });
      });
    },
    close(): void {
      socket.destroy();
    },
  };
}

// Decodes a close frame's payload into (code, reason) per RFC6455 §5.5.1:
// the first two bytes are the close code (big-endian uint16), the rest is
// the UTF-8 reason. An empty payload means no code/reason were sent.
export function decodeCloseFrame(payload: Buffer): { readonly code: number | null; readonly reason: string } {
  if (payload.length < 2) return { code: null, reason: "" };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString("utf8") };
}
