import { describe, expect, it } from "vitest";

import {
  createPinnedConnector,
  memberAddressOf,
  normalizePeer,
  peerRefusalCause,
  peerVerdict,
} from "../src/web/index.js";
import type {
  AddressRecord,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStream,
} from "../src/web/index.js";

const publicSet: readonly AddressRecord[] = [{ address: "93.184.216.34", family: 4 }];

function streamOf(chunks: Uint8Array[]): ConnectorStream {
  let index = 0;
  return {
    next() {
      if (index >= chunks.length) return Promise.resolve({ done: true as const, value: undefined });
      const value = chunks[index] as Uint8Array;
      index += 1;
      return Promise.resolve({ done: false as const, value });
    },
    async cancel() {},
  };
}

export function responseOf(
  overrides: Partial<ConnectorResponse> & { readonly chunks?: readonly Uint8Array[] },
): ConnectorResponse {
  const { chunks = [], ...rest } = overrides;
  return {
    status: 200,
    headers: { "content-type": "text/plain" },
    peer: "93.184.216.34",
    stream: streamOf([...chunks]),
    ...rest,
  };
}

export function recordedConnector(responses: readonly ConnectorResponse[]): {
  connector: { request(request: ConnectorRequest): Promise<ConnectorResponse> };
  requests: ConnectorRequest[];
  cancelCalls: number[];
} {
  const requests: ConnectorRequest[] = [];
  const cancelCalls: number[] = [];
  return {
    requests,
    cancelCalls,
    connector: {
      request(request) {
        requests.push(request);
        const response = responses[requests.length - 1];
        if (response === undefined) return Promise.reject(new Error("fixture response missing"));
        return Promise.resolve({
          ...response,
          stream: {
            next: () => response.stream.next(),
            cancel: async () => {
              cancelCalls.push(requests.length);
              await response.stream.cancel();
            },
          },
        });
      },
    },
  };
}

describe("peer normalization and verdicts", () => {
  it("normalizes IPv4-mapped peers", () => {
    expect(normalizePeer("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizePeer("93.184.216.34")).toBe("93.184.216.34");
    expect(normalizePeer("2606:4700:4700::1111")).toBe("2606:4700:4700::1111");
    expect(normalizePeer(null)).toBeNull();
  });

  it("pins the exact normative peer matrix", () => {
    expect(peerVerdict("93.184.216.34", publicSet)).toBe("ok");
    expect(peerRefusalCause("93.184.216.34", publicSet)).toBeNull();
    expect(peerVerdict(null, publicSet)).toBe("unavailable");
    expect(peerRefusalCause(null, publicSet)).toBe(
      "refusing response from unvalidated peer: peer unavailable",
    );
    expect(peerVerdict("1.2.3.4", publicSet)).toBe("not-in-validated-set");
    expect(peerRefusalCause("1.2.3.4", publicSet)).toBe(
      "refusing response from unvalidated peer: peer not in validated set",
    );
    expect(peerVerdict("10.0.0.5", publicSet)).toBe("non-public");
    expect(peerRefusalCause("10.0.0.5", publicSet)).toBe(
      "refusing response from unvalidated peer: peer is non-public",
    );
    expect(peerRefusalCause("::ffff:10.0.0.5", publicSet)).toBe(
      "refusing response from unvalidated peer: peer is non-public",
    );
    expect(memberAddressOf("::ffff:93.184.216.34", publicSet)).toBe("93.184.216.34");
  });
});

describe("createPinnedConnector", () => {
  it("dials only the validated address without resolving and preserves host/sni/tls", async () => {
    const dials: unknown[] = [];
    const connector = createPinnedConnector({
      dial: (request) => {
        dials.push(request);
        return Promise.resolve(responseOf({ chunks: [new TextEncoder().encode("ok")] }));
      },
    });
    await connector.request({
      url: "https://public.test:8443/a?b=c",
      method: "GET",
      headers: { "user-agent": "fixture" },
      allowedAddresses: publicSet,
      hostname: "public.test",
      timeoutSeconds: 10,
      deadlineMs: 10_000,
    });
    expect(dials).toHaveLength(1);
    const dial = dials[0] as {
      address: AddressRecord;
      host: string;
      secure: boolean;
      servername: string | null;
      rejectUnauthorized: boolean;
      headers: Record<string, string>;
      timeoutMs: number;
    };
    expect(dial.address).toEqual({ address: "93.184.216.34", family: 4 });
    expect(dial.host).toBe("93.184.216.34");
    expect(dial.secure).toBe(true);
    expect(dial.servername).toBe("public.test");
    expect(dial.rejectUnauthorized).toBe(true);
    expect(dial.headers.host).toBe("public.test:8443");
    expect(dial.timeoutMs).toBe(10_000);
  });

  it("never invents SNI for literal IP hosts", async () => {
    const dials: unknown[] = [];
    const connector = createPinnedConnector({
      dial: (request) => {
        dials.push(request);
        return Promise.resolve(responseOf({ chunks: [new TextEncoder().encode("ok")] }));
      },
    });
    await connector.request({
      url: "https://93.184.216.34/",
      method: "GET",
      headers: {},
      allowedAddresses: publicSet,
      hostname: "93.184.216.34",
      timeoutSeconds: 10,
      deadlineMs: 10_000,
    });
    expect((dials[0] as { servername: string | null }).servername).toBeNull();
  });

  it("rejects when the validated set is empty", async () => {
    const connector = createPinnedConnector();
    await expect(
      connector.request({
        url: "http://public.test/",
        method: "GET",
        headers: {},
        allowedAddresses: [],
        hostname: "public.test",
        timeoutSeconds: 10,
        deadlineMs: 10_000,
      }),
    ).rejects.toMatchObject({ name: "ConnectorError" });
  });
});
