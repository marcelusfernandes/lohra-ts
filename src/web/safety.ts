import type { AddressRecord, Resolver, ValidatedUrl } from "./types.js";

const ALLOWED_SCHEMES = new Set(["http", "https"]);

export class WebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebError";
  }
}

export class WebTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebTransportError";
  }
}

function parseComponent(text: string): number | null {
  if (/^0[0-9]+$/.test(text)) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    const value = Number.parseInt(text, 16);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (/^[0-9]+$/.test(text)) return Number.parseInt(text, 10);
  return null;
}

/** inet_aton-style positional IPv4 parsing: 1–4 dot-separated parts where the
 * last part carries the remaining bits. Returns the dotted canonical form. */
export function parseIpv4Literal(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  if (parts.some((part) => part.length === 0)) return null;
  const values = parts.map(parseComponent);
  if (values.some((value) => value === null)) return null;
  const numeric = values as number[];
  let value: number;
  if (numeric.length === 1) {
    if (numeric[0] === undefined || numeric[0] > 0xffffffff) return null;
    value = numeric[0];
  } else if (numeric.length === 2) {
    if ((numeric[0] ?? 0) > 255 || (numeric[1] ?? 0) > 0xffffff) return null;
    value = ((numeric[0] ?? 0) << 24) | (numeric[1] ?? 0);
  } else if (numeric.length === 3) {
    if (
      (numeric[0] ?? 0) > 255 ||
      (numeric[1] ?? 0) > 255 ||
      (numeric[2] ?? 0) > 0xffff
    )
      return null;
    value = ((numeric[0] ?? 0) << 24) | ((numeric[1] ?? 0) << 16) | (numeric[2] ?? 0);
  } else {
    if (numeric.some((part) => part > 255)) return null;
    value =
      ((numeric[0] ?? 0) << 24) |
      ((numeric[1] ?? 0) << 16) |
      ((numeric[2] ?? 0) << 8) |
      (numeric[3] ?? 0);
  }
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return [
    String((value >>> 24) & 255),
    String((value >>> 16) & 255),
    String((value >>> 8) & 255),
    String(value & 255),
  ].join(".");
}
function ipv6Groups(text: string): readonly number[] | null {
  const doubleColon = text.split("::");
  if (doubleColon.length > 2) return null;
  const head = doubleColon[0] === "" ? [] : (doubleColon[0] ?? "").split(":");
  const tail =
    doubleColon.length === 2 && doubleColon[1] !== ""
      ? (doubleColon[1] ?? "").split(":")
      : [];
  if (doubleColon.length === 1 && head.length !== 8) return null;
  if (doubleColon.length === 2 && head.length + tail.length > 7) return null;
  if (doubleColon.length === 2 && (doubleColon[0] ?? "").endsWith(":")) return null;
  if (doubleColon.length === 2 && (doubleColon[1] ?? "").startsWith(":")) return null;
  const groups: number[] = [];
  const pushGroup = (part: string): boolean => {
    if (part.length === 0 || part.length > 4) return false;
    if (!/^[0-9a-fA-F]+$/.test(part)) return false;
    groups.push(Number.parseInt(part, 16));
    return true;
  };
  const appendAll = (parts: readonly string[], allowDotted: boolean): boolean => {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined) return false;
      if (part.includes(".")) {
        if (!allowDotted || index !== parts.length - 1) return false;
        const octets = part.split(".");
        if (octets.length !== 4) return false;
        const values = octets.map((octet) =>
          /^[0-9]+$/.test(octet) && octet.length <= 3 ? Number.parseInt(octet, 10) : -1,
        );
        if (values.some((value) => value < 0 || value > 255)) return false;
        groups.push(((values[0] ?? 0) << 8) | (values[1] ?? 0));
        groups.push(((values[2] ?? 0) << 8) | (values[3] ?? 0));
      } else if (!pushGroup(part)) {
        return false;
      }
    }
    return true;
  };
  const countGroups = (parts: readonly string[]): number =>
    parts.reduce((total, part) => total + (part.includes(".") ? 2 : 1), 0);
  if (doubleColon.length === 1) {
    if (!appendAll(head, true)) return null;
    return groups.length === 8 ? groups : null;
  }
  if (!appendAll(head, false)) return null;
  const missing = 8 - groups.length - countGroups(tail);
  for (let index = 0; index < missing; index += 1) groups.push(0);
  if (!appendAll(tail, true)) return null;
  return groups;
}

function formatIpv6(groups: readonly number[]): string {
  const zeroRuns: { start: number; length: number }[] = [];
  let current: { start: number; length: number } | null = null;
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index] === 0) {
      if (current === null) current = { start: index, length: 1 };
      else current.length += 1;
    } else if (current !== null) {
      zeroRuns.push(current);
      current = null;
    }
  }
  if (current !== null) zeroRuns.push(current);
  const best = zeroRuns.filter((run) => run.length >= 2).sort((a, b) => b.length - a.length)[0];
  const head: string[] = [];
  const tail: string[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    if (best !== undefined && index >= best.start && index < best.start + best.length) continue;
    (index < (best?.start ?? 0) ? head : tail).push((groups[index] ?? 0).toString(16));
  }
  const compressed = best === undefined ? head.join(":") : `${head.join(":")}::${tail.join(":")}`;
  return compressed === "" ? "::" : compressed;
}

/** Canonicalizes an IPv6 literal the way Python's ipaddress renders it,
 * including the dotted ::ffff:a.b.c.d form for IPv4-mapped addresses. */
export function parseIpv6Literal(host: string): string | null {
  if (host.includes("%")) return null;
  const groups = ipv6Groups(host);
  if (groups === null || groups.length !== 8) return null;
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    return `::ffff:${dottedTail(groups)}`;
  }
  return formatIpv6(groups);
}

interface Range {
  readonly start: bigint;
  readonly end: bigint;
}

const IPV4_PRIVATE: readonly Range[] = [
  range4("0.0.0.0", 8),
  range4("10.0.0.0", 8),
  range4("127.0.0.0", 8),
  range4("169.254.0.0", 16),
  range4("172.16.0.0", 12),
  range4("192.0.0.0", 29),
  range4("192.0.0.170", 31),
  range4("192.0.2.0", 24),
  range4("192.168.0.0", 16),
  range4("198.18.0.0", 15),
  range4("198.51.100.0", 24),
  range4("203.0.113.0", 24),
  range4("240.0.0.0", 4),
  range4("255.255.255.255", 32),
];
const IPV4_RESERVED: readonly Range[] = [range4("240.0.0.0", 4), range4("255.255.255.255", 32)];

function range4(address: string, bits: number): Range {
  const parts = address.split(".").map((part) => BigInt(part));
  const value =
    ((parts[0] ?? 0n) << 24n) | ((parts[1] ?? 0n) << 16n) | ((parts[2] ?? 0n) << 8n) | (parts[3] ?? 0n);
  const size = 32n - BigInt(bits);
  return { start: value & ((~0n << (32n - BigInt(bits))) & 0xffffffffn), end: value | ((1n << size) - 1n) };
}

function ipv4NonPublic(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return true;
  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return true;
    value = (value << 8n) | BigInt(part);
  }
  return (
    IPV4_PRIVATE.some((range) => value >= range.start && value <= range.end) ||
    IPV4_RESERVED.some((range) => value >= range.start && value <= range.end) ||
    (value >= 0xe0000000n && value <= 0xefffffffn)
  );
}

function ipv6Value(groups: readonly number[]): bigint {
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function hasPrefix(value: bigint, prefix: bigint, bits: number): boolean {
  const shifted = value >> (128n - BigInt(bits));
  return shifted === prefix >> (128n - BigInt(bits));
}

const IPV6_PRIVATE_PREFIXES: readonly { prefix: bigint; bits: number }[] = [
  { prefix: 1n, bits: 128 },
  { prefix: 0n, bits: 128 },
  { prefix: 0xffffn << 32n, bits: 96 },
  { prefix: 0x100n << 112n, bits: 64 },
  { prefix: 0x2001n << 112n, bits: 23 },
  { prefix: 0x20010002n << 96n, bits: 48 },
  { prefix: 0x20010db8n << 96n, bits: 32 },
  { prefix: 0x20010010n << 96n, bits: 28 },
  { prefix: 0xfc00n << 112n, bits: 7 },
  { prefix: 0xfe80n << 112n, bits: 10 },
];

function ipv6NonPublic(address: string): boolean {
  const groups = ipv6Groups(address);
  if (groups === null) return true;
  const value = ipv6Value(groups);
  const firstByte = value >> 120n;
  const multicast = firstByte === 0xffn;
  const reserved = hasPrefix(value, 0n, 8);
  if (multicast || reserved) return true;
  return IPV6_PRIVATE_PREFIXES.some((entry) => hasPrefix(value, entry.prefix, entry.bits));
}

/** Python 3.12 ipaddress semantics: a non-public verdict for the classified
 * address (IPv4-mapped IPv6 is unmapped first, exactly like safety.py). */
export function isNonPublic(address: string): boolean {
  if (address.includes(":")) {
    const mapped = ipv4MappedOf(address);
    return mapped === null ? ipv6NonPublic(address) : ipv4NonPublic(mapped);
  }
  return ipv4NonPublic(address);
}

function dottedTail(groups: readonly number[]): string {
  const sixth = groups[6] ?? 0;
  const seventh = groups[7] ?? 0;
  return [String(sixth >> 8), String(sixth & 255), String(seventh >> 8), String(seventh & 255)].join(".");
}

function ipv4MappedOf(address: string): string | null {
  const groups = ipv6Groups(address);
  if (groups === null) return null;
  if (!groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) return null;
  return dottedTail(groups);
}

export function unmap(address: string): string {
  return ipv4MappedOf(address) ?? address;
}

function authorityOf(url: string, schemeLength: number): { authority: string; hasDoubleSlash: boolean } {
  const rest = url.slice(schemeLength);
  if (!rest.startsWith("//")) return { hasDoubleSlash: false, authority: "" };
  const remainder = rest.slice(2);
  const terminator = remainder.search(/[/?#]/);
  return { hasDoubleSlash: true, authority: terminator === -1 ? remainder : remainder.slice(0, terminator) };
}

function displayHost(authority: string): string {
  const at = authority.lastIndexOf("@");
  return at === -1 ? authority : authority.slice(at + 1);
}

function portTextOf(authority: string): string | null {
  const host = displayHost(authority);
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) return null;
    const rest = host.slice(close + 1);
    if (!rest.startsWith(":")) return "";
    return rest.slice(1);
  }
  const colon = host.lastIndexOf(":");
  if (colon === -1) return "";
  return host.slice(colon + 1);
}

function stripPort(host: string): string {
  if (host.includes("]")) return host;
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

function checkPort(authority: string): void {
  const portText = portTextOf(authority);
  if (portText === null) return;
  if (portText === "") return;
  if (!/^[0-9]+$/.test(portText) || Number.parseInt(portText, 10) > 65535) {
    throw new WebTransportError(`Invalid port: '${portText}'`);
  }
}

export async function validatePublicUrl(
  url: string,
  deps: { resolver: Resolver },
): Promise<ValidatedUrl> {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  const scheme = (schemeMatch?.[1] ?? "").toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    throw new WebError(`unsupported URL scheme: '${scheme || "(none)"}' (http/https only)`);
  }
  const authority = authorityOf(url, scheme.length + 1);
  if (!authority.hasDoubleSlash || authority.authority === "") {
    throw new WebError("URL has no host");
  }
  if (authority.authority.includes("@")) {
    throw new WebError("refusing URL with embedded credentials");
  }
  const host = displayHost(authority.authority);
  if (host.startsWith("[") && host.includes("%")) {
    throw new WebError("invalid URL: IPv6 zone identifiers are not allowed");
  }
  checkPort(authority.authority);
  const parsed = new URL(url);
  const bracketed = parsed.hostname.startsWith("[");
  const hostname = bracketed
    ? parsed.hostname.slice(1, Math.max(1, parsed.hostname.indexOf("]")))
    : parsed.hostname;
  if (hostname === "") throw new WebError("URL has no host");
  const rawHost = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : stripPort(host);
  const port = parsed.port === "" ? null : Number.parseInt(parsed.port, 10);
  const literalV4 = hostname.includes(":") ? null : parseIpv4Literal(hostname);
  if (literalV4 !== null) {
    if (isNonPublic(literalV4)) {
      throw new WebError(`refusing to fetch a non-public address: ${literalV4} (host '${rawHost}')`);
    }
    return {
      scheme,
      hostname: rawHost,
      port,
      addresses: [{ address: literalV4, family: 4 }],
      url: parsed,
    };
  }
  if (hostname.includes(":")) {
    const literalV6 = parseIpv6Literal(hostname);
    if (literalV6 === null) throw new WebError(`invalid URL: ${hostname}`);
    if (isNonPublic(unmap(literalV6))) {
      throw new WebError(
        `refusing to fetch a non-public address: ${literalV6} (host '${rawHost}')`,
      );
    }
    return {
      scheme,
      hostname: rawHost,
      port,
      addresses: [{ address: literalV6, family: 6 }],
      url: parsed,
    };
  }
  let resolved: readonly AddressRecord[];
  try {
    resolved = await deps.resolver(hostname, null);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new WebError(`could not resolve host '${rawHost}': ${cause}`);
  }
  const list: AddressRecord[] = [...resolved];
  if (list.length === 0) {
    throw new WebError(`could not resolve host '${rawHost}'`);
  }
  for (const record of resolved) {
    const ip = unmap(record.address);
    if (isNonPublic(ip)) {
      throw new WebError(`refusing to fetch a non-public address: ${ip} (host '${hostname}')`);
    }
  }
  return { scheme, hostname, port, addresses: Object.freeze([...resolved]), url: parsed };
}
