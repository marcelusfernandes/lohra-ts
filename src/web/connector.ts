import nodeDns from "node:dns";
import { isNonPublic, unmap } from "./safety.js";
import type {
  AddressRecord,
  ConnectorResponse,
  ConnectorStream,
  HttpConnector,
} from "./types.js";

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface PinnedDialRequest {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly address: AddressRecord;
  readonly host: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly secure: boolean;
  readonly servername: string | null;
  readonly rejectUnauthorized: boolean;
  readonly timeoutMs: number;
  readonly body?: string;
}

export type Dial = (request: PinnedDialRequest) => Promise<ConnectorResponse>;

export interface ConnectorOptions {
  readonly dial?: Dial;
}

export function normalizePeer(peer: string | null | undefined): string | null {
  if (peer === null || peer === undefined) return null;
  const trimmed = peer.trim();
  if (trimmed === "") return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  if (mapped !== null) return mapped[1] ?? null;
  const groups = trimmed.split(":");
  if (
    groups.length === 8 &&
    groups.slice(0, 5).every((group) => Number.parseInt(group, 16) === 0) &&
    Number.parseInt(groups[5] ?? "0", 16) === 0xffff
  ) {
    const sixth = Number.parseInt(groups[6] ?? "0", 16);
    const seventh = Number.parseInt(groups[7] ?? "0", 16);
    return [String(sixth >> 8), String(sixth & 255), String(seventh >> 8), String(seventh & 255)].join(".");
  }
  return trimmed;
}

export function memberAddressOf(
  peer: string | null,
  allowed: readonly AddressRecord[],
): string | null {
  const normalized = normalizePeer(peer);
  if (normalized === null) return null;
  const direct = allowed.find((record) => record.address === normalized);
  if (direct !== undefined) return direct.address;
  const mapped = allowed.find((record) => unmap(record.address) === unmap(normalized));
  return mapped?.address ?? null;
}

export type PeerVerdict =
  | "unavailable"
  | "not-in-validated-set"
  | "non-public"
  | "ok";

export function peerVerdict(
  peer: string | null,
  allowed: readonly AddressRecord[],
): PeerVerdict {
  if (peer === null) return "unavailable";
  const normalized = normalizePeer(peer) ?? peer;
  if (isNonPublic(unmap(normalized))) return "non-public";
  if (memberAddressOf(peer, allowed) === null) return "not-in-validated-set";
  return "ok";
}

export function peerRefusalCause(
  peer: string | null,
  allowed: readonly AddressRecord[],
): string | null {
  const verdict = peerVerdict(peer, allowed);
  if (verdict === "ok") return null;
  if (verdict === "unavailable") return "refusing response from unvalidated peer: peer unavailable";
  if (verdict === "not-in-validated-set")
    return "refusing response from unvalidated peer: peer not in validated set";
  return "refusing response from unvalidated peer: peer is non-public";
}

function isIpLiteral(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");
}

function hostHeader(url: URL, hostname: string): string {
  const port = url.port === "" ? null : Number.parseInt(url.port, 10);
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  if (port === null || port === defaultPort) return hostname;
  return `${hostname}:${String(port)}`;
}

export function createPinnedConnector(options: ConnectorOptions = {}): HttpConnector {
  const dial = options.dial ?? nodeDial;
  return {
    request(request) {
      const url = new URL(request.url);
      const secure = url.protocol === "https:";
      const allowed = request.allowedAddresses;
      if (allowed.length === 0) {
        return Promise.reject(new ConnectorError("no validated address to connect to"));
      }
      return dial({
        method: request.method,
        url,
        address: allowed[0] as AddressRecord,
        host: (allowed[0] as AddressRecord).address,
        headers: { ...request.headers, host: hostHeader(url, request.hostname) },
        ...(request.body === undefined ? {} : { body: request.body }),
        secure,
        servername: secure && !isIpLiteral(request.hostname) ? request.hostname : null,
        rejectUnauthorized: true,
        timeoutMs: request.timeoutSeconds * 1000,
      });
    },
  };
}

export function createPlainConnector(): HttpConnector {
  const dial = nodeDial;
  return {
    request(request) {
      const url = new URL(request.url);
      const secure = url.protocol === "https:";
      return dial({
        method: request.method,
        url,
        address: { address: request.hostname, family: 4 },
        host: request.hostname,
        headers: { ...request.headers, host: hostHeader(url, request.hostname) },
        ...(request.body === undefined ? {} : { body: request.body }),
        secure,
        servername: secure ? request.hostname : null,
        rejectUnauthorized: true,
        timeoutMs: request.timeoutSeconds * 1000,
      });
    },
  };
}

async function nodeDial(dialRequest: PinnedDialRequest): Promise<ConnectorResponse> {
  const [nodeHttp, nodeHttps] = await Promise.all([
    import("node:http"),
    import("node:https"),
  ]);
  const transport = dialRequest.secure ? nodeHttps : nodeHttp;
  return new Promise<ConnectorResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      nodeRequest.destroy();
      reject(new ConnectorError(`request timed out after ${String(Math.round(dialRequest.timeoutMs / 1000))} seconds`));
    }, dialRequest.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    const nodeRequest = transport.request(
      {
        host: dialRequest.host,
        port: dialRequest.url.port === "" ? (dialRequest.secure ? 443 : 80) : Number.parseInt(dialRequest.url.port, 10),
        method: dialRequest.method,
        path: `${dialRequest.url.pathname}${dialRequest.url.search}`,
        headers: { ...dialRequest.headers },
        ...(dialRequest.secure
          ? {
              ...(dialRequest.servername === null ? {} : { servername: dialRequest.servername }),
              rejectUnauthorized: dialRequest.rejectUnauthorized,
            }
          : {}),
      },
      (nodeResponse) => {
        const headers: Record<string, string> = {};
        const rawHeaders = nodeResponse.headers as Readonly<Record<string, string | string[] | number | undefined>>;
        for (const [name, value] of Object.entries(rawHeaders)) {
          if (Array.isArray(value)) {
            headers[name.toLowerCase()] = value.join(", ");
          } else if (typeof value === "string") {
            headers[name.toLowerCase()] = value;
          } else if (value !== undefined) {
            headers[name.toLowerCase()] = String(value);
          }
        }
        let ended = false;
        const stream: ConnectorStream = {
          next() {
            if (ended) return Promise.resolve({ done: true, value: undefined });
            const ready = nodeResponse.read() as Buffer | null;
            if (ready !== null) return Promise.resolve({ done: false, value: new Uint8Array(ready) });
            return new Promise((resolveChunk) => {
              const onReadable = (): void => {
                cleanup();
                const chunk = nodeResponse.read() as Buffer | null;
                if (chunk === null) {
                  if (nodeResponse.readableEnded) {
                    ended = true;
                    resolveChunk({ done: true, value: undefined });
                    return;
                  }
                  const drained = nodeResponse.read() as Buffer | null;
                  resolveChunk(
                    drained === null
                      ? { done: true, value: undefined }
                      : { done: false, value: new Uint8Array(drained) },
                  );
                  return;
                }
                resolveChunk({ done: false, value: new Uint8Array(chunk) });
              };
              const onEnd = (): void => {
                cleanup();
                ended = true;
                resolveChunk({ done: true, value: undefined });
              };
              const cleanup = (): void => {
                nodeResponse.off("readable", onReadable);
                nodeResponse.off("end", onEnd);
              };
              nodeResponse.once("readable", onReadable);
              nodeResponse.once("end", onEnd);
            });
          },
          cancel() {
            clearTimeout(timer);
            nodeResponse.destroy();
            return Promise.resolve();
          },
        };
        clearTimeout(timer);
        resolve({
          status: nodeResponse.statusCode ?? 0,
          headers,
          peer: normalizePeer(nodeResponse.socket.remoteAddress ?? null),
          stream,
        });
      },
    );
    nodeRequest.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    nodeRequest.end(dialRequest.body);
  });
}

export function nodeResolver(host: string, _port: number | null): Promise<AddressRecord[]> {
  return nodeDns.promises.lookup(host, { all: true, verbatim: true }).then((records) =>
    records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 })),
  );
}
