import { describe, expect, it } from "vitest";

import {
  isNonPublic,
  parseIpv4Literal,
  parseIpv6Literal,
  WebError,
  WebTransportError,
  validatePublicUrl,
  type Resolver,
} from "../src/web/index.js";

const table: Record<string, readonly string[]> = {
  "resolver-table": ["93.184.216.34"],
  "private.test": ["10.0.0.5"],
  "mixed.test": ["93.184.216.34", "10.0.0.5"],
  "empty.test": [],
  "v6-public.test": ["2606:4700:4700::1111"],
  "v6-loopback.test": ["::1"],
  "v6-mapped.test": ["::ffff:127.0.0.1"],
  "v6-mixed.test": ["2606:4700:4700::1111", "fe80::1"],
};

function resolver(calls: string[]): Resolver {
  return (host) => {
    calls.push(host);
    if (host === "boom.test") throw new Error("fixture DNS failed");
    const ips = table[host];
    return (ips ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

describe("ip classification", () => {
  it("classifies every normative address family like the oracle", () => {
    const nonPublic = [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.9",
      "192.168.1.1",
      "169.254.1.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "0.0.0.0",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "192.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12::1",
      "ff02::1",
      "2001:db8::1",
      "100::1",
      "2001:2::1",
      "2001:10::1",
      "2001::1",
      "::ffff:127.0.0.1",
    ];
    for (const address of nonPublic) expect(isNonPublic(address), address).toBe(true);
    for (const address of [
      "93.184.216.34",
      "8.8.8.8",
      "1.1.1.1",
      "2606:4700:4700::1111",
      "100.64.0.1",
      "200.1.1.1",
      "192.0.0.9",
      "192.0.0.10",
      "192.88.99.1",
      "2001:1::1",
      "2001:1::2",
      "2001:3::1",
      "2001:4:112::1",
      "2001:20::1",
      "2001:30::1",
    ])
      expect(isNonPublic(address), address).toBe(false);
  });

  it("refuses the 3.12.10 adversarial set: 3fff::/20, 2002::/16, 64:ff9b:1::/48, fec0 excluded", () => {
    for (const address of [
      "3fff::1",
      "3fff:fff::1",
      "2002::1",
      "64:ff9b:1::1",
      "2001:44::1",
      "2001:100::1",
      "2001:1::3",
      "5f00::1",
    ]) {
      expect(isNonPublic(address), address).toBe(true);
    }
    for (const address of ["fec0::1", "3fff:ffff::", "2001:1::2", "2001:3::1"]) {
      expect(isNonPublic(address), address).toBe(false);
    }
    expect(isNonPublic("2001:1::4")).toBe(true);
  });

  it("classifies high first octet IPv4 literals without signed-bitwise wraparound", () => {
    expect(parseIpv4Literal("200.1.1.1")).toBe("200.1.1.1");
    expect(isNonPublic("200.1.1.1")).toBe(false);
    expect(isNonPublic("224.0.0.5")).toBe(true);
    expect(isNonPublic("240.0.0.1")).toBe(true);
    expect(parseIpv4Literal("200.1.1.1") !== null).toBe(true);
  });

  it("unmaps IPv4-mapped IPv6 before classification", () => {
    expect(isNonPublic("::ffff:10.0.0.5")).toBe(true);
    expect(isNonPublic("::ffff:93.184.216.34")).toBe(false);
  });
});

describe("ipv4 literal parsing", () => {
  it("canonicalizes decimal, hexadecimal and short loopback forms", () => {
    expect(parseIpv4Literal("2130706433")).toBe("127.0.0.1");
    expect(parseIpv4Literal("0x7f000001")).toBe("127.0.0.1");
    expect(parseIpv4Literal("127.1")).toBe("127.0.0.1");
    expect(parseIpv4Literal("93.184.216.34")).toBe("93.184.216.34");
  });

  it("rejects malformed quads as non-literals", () => {
    expect(parseIpv4Literal("999.1.1.1")).toBeNull();
    expect(parseIpv4Literal("1.2.3.4.5")).toBeNull();
    expect(parseIpv4Literal("public.test")).toBeNull();
    expect(parseIpv4Literal("1.2.x.4")).toBeNull();
    expect(parseIpv4Literal("0x100000000")).toBeNull();
  });
});

describe("ipv6 literal parsing", () => {
  it("canonicalizes public and non-public literals", () => {
    expect(parseIpv6Literal("2606:4700:4700::1111")).toBe("2606:4700:4700::1111");
    expect(parseIpv6Literal("::1")).toBe("::1");
    expect(parseIpv6Literal("0:0:0:0:0:ffff:7f00:1")).toBe("::ffff:127.0.0.1");
  });

  it("rejects garbage as non-literals", () => {
    expect(parseIpv6Literal("public.test")).toBeNull();
    expect(parseIpv6Literal("gggg::1")).toBeNull();
  });
});

describe("validatePublicUrl", () => {
  it("accepts public http and https hostnames with a single immutable resolution", async () => {
    const calls: string[] = [];
    const first = await validatePublicUrl("http://resolver-table/a", { resolver: resolver(calls) });
    expect(first.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(first.hostname).toBe("resolver-table");
    expect(first.scheme).toBe("http");
    expect(calls).toEqual(["resolver-table"]);
    const second = await validatePublicUrl("https://v6-public.test/", {
      resolver: resolver(calls),
    });
    expect(second.addresses).toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    expect(calls).toEqual(["resolver-table", "v6-public.test"]);
  });

  it("pins public literals with zero resolver calls", async () => {
    const calls: string[] = [];
    const validated = await validatePublicUrl("http://93.184.216.34/x", {
      resolver: resolver(calls),
    });
    expect(validated.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(calls).toEqual([]);
    const v6 = await validatePublicUrl("http://[2606:4700:4700::1111]/", {
      resolver: resolver(calls),
    });
    expect(v6.addresses).toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    expect(calls).toEqual([]);
  });

  it("refuses non-http(s) schemes with the oracle literals", async () => {
    const calls: string[] = [];
    for (const [url, cause] of [
      ["puBlic.test/x", "unsupported URL scheme: '(none)' (http/https only)"],
      ["file:///etc/passwd", "unsupported URL scheme: 'file' (http/https only)"],
      ["ftp://public.test/x", "unsupported URL scheme: 'ftp' (http/https only)"],
      ["", "unsupported URL scheme: '(none)' (http/https only)"],
    ] as const) {
      try {
        await validatePublicUrl(url, { resolver: resolver(calls) });
        expect.unreachable(url);
      } catch (error) {
        expect(error).toBeInstanceOf(WebError);
        expect((error as WebError).message).toBe(cause);
      }
    }
    expect(calls).toEqual([]);
  });

  it("refuses URLs without a host", async () => {
    const calls: string[] = [];
    try {
      await validatePublicUrl("http:///path", { resolver: resolver(calls) });
      expect.unreachable("no host");
    } catch (error) {
      expect((error as WebError).message).toBe("URL has no host");
    }
    expect(calls).toEqual([]);
  });

  it("refuses userinfo before any resolution (decision 1)", async () => {
    const calls: string[] = [];
    for (const url of [
      "http://alice:secret@public.test/",
      "http://alice@public.test/",
      "http://:secret@public.test/",
      "http://@public.test/",
      "http://al%69ce:secret@public.test/",
      "http://a@b@public.test/",
    ]) {
      try {
        await validatePublicUrl(url, { resolver: resolver(calls) });
        expect.unreachable(url);
      } catch (error) {
        expect((error as WebError).message).toBe("refusing URL with embedded credentials");
      }
    }
    expect(calls).toEqual([]);
  });

  it("rejects IPv6 zone identifiers with the exact E2 cause", async () => {
    const calls: string[] = [];
    try {
      await validatePublicUrl("http://[fe80::1%25eth0]/", { resolver: resolver(calls) });
      expect.unreachable("zone");
    } catch (error) {
      expect((error as WebError).message).toBe(
        "invalid URL: IPv6 zone identifiers are not allowed",
      );
    }
    expect(calls).toEqual([]);
  });

  it("rejects syntactically invalid ports as transport errors before DNS (E1)", async () => {
    const calls: string[] = [];
    for (const url of ["http://public.test:bad/", "http://public.test:99999/"]) {
      try {
        await validatePublicUrl(url, { resolver: resolver(calls) });
        expect.unreachable(url);
      } catch (error) {
        expect(error).toBeInstanceOf(WebTransportError);
        expect((error as WebTransportError).message).toMatch(/Invalid port/);
      }
    }
    expect(calls).toEqual([]);
  });

  it("maps resolver failures and empty answers to the oracle causes", async () => {
    const calls: string[] = [];
    try {
      await validatePublicUrl("http://boom.test/", { resolver: resolver(calls) });
      expect.unreachable("gaierror");
    } catch (error) {
      expect((error as WebError).message).toBe(
        "could not resolve host 'boom.test': fixture DNS failed",
      );
    }
    try {
      await validatePublicUrl("http://empty.test/", { resolver: resolver(calls) });
      expect.unreachable("empty");
    } catch (error) {
      expect((error as WebError).message).toBe("could not resolve host 'empty.test'");
    }
    expect(calls).toEqual(["boom.test", "empty.test"]);
  });

  it("refuses the whole set when any address is non-public", async () => {
    const calls: string[] = [];
    for (const [url, ip, host] of [
      ["http://private.test/", "10.0.0.5", "private.test"],
      ["http://mixed.test/", "10.0.0.5", "mixed.test"],
      ["http://v6-loopback.test/", "::1", "v6-loopback.test"],
      ["http://v6-mixed.test/", "fe80::1", "v6-mixed.test"],
    ] as const) {
      try {
        await validatePublicUrl(url, { resolver: resolver(calls) });
        expect.unreachable(url);
      } catch (error) {
        expect((error as WebError).message).toBe(
          `refusing to fetch a non-public address: ${ip} (host '${host}')`,
        );
      }
    }
    expect(calls).toEqual(["private.test", "mixed.test", "v6-loopback.test", "v6-mixed.test"]);
  });

  it("refuses loopback literals with zero DNS in every alternative form", async () => {
    const calls: string[] = [];
    for (const host of ["2130706433", "0x7f000001", "127.1"]) {
      try {
        await validatePublicUrl(`http://${host}/`, { resolver: resolver(calls) });
        expect.unreachable(host);
      } catch (error) {
        expect((error as WebError).message).toBe(
          `refusing to fetch a non-public address: 127.0.0.1 (host '${host}')`,
        );
      }
    }
    expect(calls).toEqual([]);
    try {
      await validatePublicUrl("http://[::1]/", { resolver: resolver(calls) });
      expect.unreachable("::1");
    } catch (error) {
      expect((error as WebError).message).toBe(
        "refusing to fetch a non-public address: ::1 (host '::1')",
      );
    }
    expect(calls).toEqual([]);
  });

  it("refuses non-public literal forms with zero DNS and no port-class change", async () => {
    const calls: string[] = [];
    for (const [url, ip, raw] of [
      ["http://10.0.0.5:8080/", "10.0.0.5", "10.0.0.5"],
      ["http://[fe80::1]:8080/", "fe80::1", "fe80::1"],
      ["http://[::ffff:127.0.0.1]/", "::ffff:127.0.0.1", "::ffff:127.0.0.1"],
    ] as const) {
      try {
        await validatePublicUrl(url, { resolver: resolver(calls) });
        expect.unreachable(url);
      } catch (error) {
        expect((error as WebError).message).toBe(
          `refusing to fetch a non-public address: ${ip} (host '${raw}')`,
        );
      }
    }
    expect(calls).toEqual([]);
  });
});
