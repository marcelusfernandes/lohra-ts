import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { isIP } from "node:net";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  MAX_DATA_URI_BASE64_CHARS,
  MAX_HTTP_URL_CHARS,
  MAX_VISION_IMAGE_BYTES,
} from "./constants.js";

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

  let bytes: Buffer;
  try {
    revalidateLocalRoot(guard);
    rejectSymlinks(root, candidate);
    const second = statSync(candidate);
    const secondCanonical = realpathSync(candidate);
    if (secondCanonical !== canonical || !sameIdentity(initial, second))
      throw new Error("image changed after preflight");
    bytes = readFileSync(candidate);
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
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && values[2] === 100) ||
    (first === 203 && second === 0 && values[2] === 113) ||
    first >= 224
  );
}

function unsafeHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const version = isIP(host);
  if (version === 4) return unsafeIpv4(host);
  if (version === 6)
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("2001:db8:") ||
      host === "2001:db8::" ||
      host.startsWith("::ffff:")
    );
  return false;
}

function isBase64Alphabet(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let bodyLength = value.length;
  if (value.endsWith("==")) bodyLength -= 2;
  else if (value.endsWith("=")) bodyLength -= 1;
  for (let index = 0; index < bodyLength; index += 1) {
    if (!isBase64Alphabet(value.charCodeAt(index))) return false;
  }
  for (let index = bodyLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
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
    if (!isStrictBase64(payload)) throw new Error("invalid image base64 payload");
    const bytes = (options.decode ?? ((encoded) => Buffer.from(encoded, "base64")))(payload);
    if (Buffer.from(bytes).toString("base64") !== payload)
      throw new Error("invalid image base64 payload");
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
  readonly afterInputPreflight?: () => void | Promise<void>;
}): Promise<ImagePart> {
  if (options.path !== undefined)
    return buildLocalImagePart({
      path: options.path,
      localRoot: options.localRoot ?? process.cwd(),
      ...(options.rootGuard === undefined ? {} : { rootGuard: options.rootGuard }),
      ...(options.afterInputPreflight === undefined
        ? {}
        : { afterInputPreflight: options.afterInputPreflight }),
    });
  if (options.url === undefined) throw new Error("vision_analyze requires a 'path' or a 'url'");
  return { type: "image_url", image_url: { url: validateRemoteImage(options.url) } };
}
