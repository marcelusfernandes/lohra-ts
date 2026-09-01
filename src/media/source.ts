import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { isIP } from "node:net";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  MAX_DATA_URI_BASE64_CHARS,
  MAX_HTTP_URL_CHARS,
  MAX_VISION_IMAGE_BYTES,
} from "./constants.js";
import { decodeStrictBase64 } from "./base64.js";

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ImagePart {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
}

export interface LocalRootGuard {
  readonly suppliedRoot: string;
  readonly canonicalRoot: string;
  readonly dev: number;
  readonly ino: number;
}

export const textPart = (text: string): TextPart => ({ type: "text", text });

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
});

function contained(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return (
    suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
  );
}

function componentsBelow(root: string, target: string): readonly string[] {
  const suffix = relative(root, target);
  if (!contained(root, target)) throw new Error("image path is outside localRoot");
  if (suffix === "") return [];
  const result: string[] = [];
  let cursor = root;
  for (const part of suffix.split(sep)) {
    cursor = resolve(cursor, part);
    result.push(cursor);
  }
  return result;
}

function rejectSymlinks(root: string, target: string): void {
  for (const component of componentsBelow(root, target)) {
    const stats = lstatSync(component);
    if (stats.isSymbolicLink()) throw new Error("image path contains a symlink");
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameRootIdentity(guard: LocalRootGuard, stats: Stats): boolean {
  return guard.dev === stats.dev && guard.ino === stats.ino;
}

export function captureLocalRoot(localRoot: string): LocalRootGuard {
  const suppliedRoot = resolve(localRoot);
  const canonicalRoot = realpathSync(suppliedRoot);
  const stats = statSync(canonicalRoot);
  if (!stats.isDirectory()) throw new Error("localRoot must be a directory");
  return Object.freeze({
    suppliedRoot,
    canonicalRoot,
    dev: stats.dev,
    ino: stats.ino,
  });
}

function revalidateLocalRoot(guard: LocalRootGuard): void {
  try {
    if (realpathSync(guard.suppliedRoot) !== guard.canonicalRoot) {
      throw new Error("localRoot changed after preflight");
    }
    const stats = statSync(guard.canonicalRoot);
    if (!stats.isDirectory() || !sameRootIdentity(guard, stats)) {
      throw new Error("localRoot changed after preflight");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "localRoot changed after preflight") {
      throw error;
    }
    throw new Error("localRoot changed after preflight", { cause: error });
  }
}

function mimeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === "") return "image/png";
  return MIME_BY_EXTENSION[extension] ?? "text/plain";
}

function missing(path: string, error: unknown): Error {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return code === "ENOENT"
    ? new Error(`no such image file: ${path}`)
    : new Error(
        `failed to read image ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
}

export async function buildLocalImagePart(options: {
  readonly path: string;
  readonly localRoot: string;
  readonly rootGuard?: LocalRootGuard;
  readonly readFile?: (path: string) => Buffer;
  readonly afterInputPreflight?: () => void | Promise<void>;
}): Promise<ImagePart> {
  const guard = options.rootGuard ?? captureLocalRoot(options.localRoot);
  const suppliedRoot = guard.suppliedRoot;
  const root = guard.canonicalRoot;
  const suppliedPath = resolve(options.path);
  const candidate = isAbsolute(options.path)
    ? contained(suppliedRoot, suppliedPath)
      ? resolve(root, relative(suppliedRoot, suppliedPath))
      : suppliedPath
    : resolve(root, options.path);
  if (!contained(root, candidate)) throw new Error("image path is outside localRoot");
  let initial: Stats;
  let canonical: string;
  try {
    rejectSymlinks(root, candidate);
    initial = statSync(candidate);
    canonical = realpathSync(candidate);
  } catch (error) {
    throw missing(options.path, error);
  }
  if (!contained(root, canonical)) throw new Error("image path is outside localRoot");
  if (!initial.isFile()) throw new Error(`no such image file: ${options.path}`);
  if (initial.size > MAX_VISION_IMAGE_BYTES) throw new Error("image exceeds 20 MiB limit");
  const mime = mimeFor(candidate);
  if (!mime.startsWith("image/")) throw new Error(`${options.path} is not an image (${mime})`);

  await options.afterInputPreflight?.();

  let second: Stats;
  let secondCanonical: string;
  try {
    revalidateLocalRoot(guard);
    rejectSymlinks(root, candidate);
    second = statSync(candidate);
    secondCanonical = realpathSync(candidate);
    if (secondCanonical !== canonical || !sameIdentity(initial, second))
      throw new Error("image changed after preflight");
  } catch (error) {
    if (error instanceof Error && error.message === "localRoot changed after preflight")
      throw error;
    if (error instanceof Error && error.message === "image changed after preflight") throw error;
    throw new Error("image changed after preflight", { cause: error });
  }

  let bytes: Buffer;
  try {
    bytes = (options.readFile ?? readFileSync)(candidate);
  } catch (error) {
    throw missing(options.path, error);
  }
  try {
    const final = statSync(candidate);
    if (!sameIdentity(second, final) || bytes.byteLength !== final.size)
      throw new Error("image changed after preflight");
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "image changed after preflight" ||
        error.message === "localRoot changed after preflight")
    )
      throw error;
    throw new Error("image changed after preflight", { cause: error });
  }
  if (bytes.byteLength > MAX_VISION_IMAGE_BYTES) throw new Error("image exceeds 20 MiB limit");
  return {
    type: "image_url",
    image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` },
  };
}

function unsafeIpv4(host: string): boolean {
  const values = host.split(".").map(Number);
  const first = values[0] ?? -1;
  const second = values[1] ?? -1;
  const third = values[2] ?? -1;
  const fourth = values[3] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0 && fourth !== 9 && fourth !== 10) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && values[2] === 100) ||
    (first === 203 && second === 0 && values[2] === 113) ||
    first >= 224
  );
}

function ipv6Words(host: string): readonly number[] | null {
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const left = (halves[0] ?? "").split(":").filter(Boolean);
  const right = (halves[1] ?? "").split(":").filter(Boolean);
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const values = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  return values.length === 8 && values.every((value) => Number.isInteger(value)) ? values : null;
}

function prefix(words: readonly number[], bits: number, expected: readonly number[]): boolean {
  const complete = Math.floor(bits / 16);
  const remainder = bits % 16;
  for (let index = 0; index < complete; index += 1) {
    if (words[index] !== expected[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = (0xffff << (16 - remainder)) & 0xffff;
  return ((words[complete] ?? 0) & mask) === ((expected[complete] ?? 0) & mask);
}

function embeddedIpv4(words: readonly number[]): string {
  const high = words[6] ?? 0;
  const low = words[7] ?? 0;
  return `${String(high >>> 8)}.${String(high & 0xff)}.${String(low >>> 8)}.${String(low & 0xff)}`;
}

function unsafeIpv6(host: string): boolean {
  const words = ipv6Words(host);
  if (words === null) return true;
  const isMapped = prefix(words, 96, [0, 0, 0, 0, 0, 0xffff]);
  const isCompatible = prefix(words, 96, [0, 0, 0, 0, 0, 0]);
  const isNat64 = prefix(words, 96, [0x64, 0xff9b, 0, 0, 0, 0]);
  const isSixToFour = prefix(words, 16, [0x2002]);
  if (isMapped || isCompatible || isNat64) return unsafeIpv4(embeddedIpv4(words));
  if (isSixToFour) {
    const high = words[1] ?? 0;
    const low = words[2] ?? 0;
    return unsafeIpv4(
      `${String(high >>> 8)}.${String(high & 0xff)}.${String(low >>> 8)}.${String(low & 0xff)}`,
    );
  }
  return (
    words.every((value) => value === 0) ||
    (words.slice(0, 7).every((value) => value === 0) && words[7] === 1) ||
    prefix(words, 7, [0xfc00]) ||
    prefix(words, 10, [0xfe80]) ||
    prefix(words, 10, [0xfec0]) ||
    prefix(words, 8, [0xff00]) ||
    prefix(words, 64, [0x100, 0, 0, 0]) ||
    prefix(words, 48, [0x64, 0xff9b, 1]) ||
    prefix(words, 32, [0x2001, 0]) ||
    prefix(words, 48, [0x2001, 2, 0]) ||
    prefix(words, 28, [0x2001, 0x10]) ||
    prefix(words, 28, [0x2001, 0x20]) ||
    prefix(words, 32, [0x2001, 0x0db8]) ||
    prefix(words, 20, [0x3fff]) ||
    prefix(words, 16, [0x5f00])
  );
}

function unsafeHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const version = isIP(host);
  if (version === 4) return unsafeIpv4(host);
  if (version === 6) return unsafeIpv6(host);
  return false;
}

export function validateRemoteImage(
  value: string,
  options: { readonly decode?: (value: string) => Uint8Array } = {},
): string {
  if (value.startsWith("data:")) {
    const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,(.*)$/.exec(value);
    if (match === null) throw new Error("expected an image data URI");
    const payload = match[2] ?? "";
    if (payload.length > MAX_DATA_URI_BASE64_CHARS) throw new Error("image data URI is too large");
    let bytes: Uint8Array;
    try {
      bytes = decodeStrictBase64(payload, options.decode);
    } catch {
      throw new Error("invalid image base64 payload");
    }
    if (bytes.byteLength > MAX_VISION_IMAGE_BYTES)
      throw new Error("image data exceeds 20 MiB limit");
    return value;
  }

  if (value.length > MAX_HTTP_URL_CHARS) throw new Error("image URL is too long");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("unsupported image URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("unsupported image URL");
  if (parsed.hostname.length === 0) throw new Error("unsupported image URL");
  if (parsed.username !== "" || parsed.password !== "")
    throw new Error("image URL credentials are forbidden");
  if (unsafeHost(parsed.hostname)) throw new Error("unsafe image host");
  return value;
}

export async function buildImagePart(options: {
  readonly path?: string;
  readonly url?: string;
  readonly localRoot?: string;
  readonly rootGuard?: LocalRootGuard;
  readonly readFile?: (path: string) => Buffer;
  readonly afterInputPreflight?: () => void | Promise<void>;
}): Promise<ImagePart> {
  if (options.path !== undefined)
    return buildLocalImagePart({
      path: options.path,
      localRoot: options.localRoot ?? process.cwd(),
      ...(options.rootGuard === undefined ? {} : { rootGuard: options.rootGuard }),
      ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
      ...(options.afterInputPreflight === undefined
        ? {}
        : { afterInputPreflight: options.afterInputPreflight }),
    });
  if (options.url === undefined) throw new Error("vision_analyze requires a 'path' or a 'url'");
  return { type: "image_url", image_url: { url: validateRemoteImage(options.url) } };
}
