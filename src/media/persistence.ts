import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  IMAGE_FILE_MODE,
  MAX_IMAGE_BATCH_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_DATA_URI_BASE64_CHARS,
} from "./constants.js";
import { decodeStrictBase64 } from "./base64.js";

export const MEDIA_TOCTOU_LIMITATION =
  "Node does not expose portable openat/renameat2; observable checkpoints are fail-closed, but an unobservable path swap between a check and a path syscall cannot be eliminated.";

export interface OutputPlan {
  readonly trustedParent: string;
  readonly outDir: string;
  readonly parentDev: number;
  readonly parentIno: number;
}

function contained(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return (
    suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
  );
}

function identity(stats: Stats, plan: OutputPlan): boolean {
  return stats.dev === plan.parentDev && stats.ino === plan.parentIno;
}

function checkTrustedParent(plan: OutputPlan): void {
  const parent = statSync(plan.trustedParent);
  if (
    !parent.isDirectory() ||
    !identity(parent, plan) ||
    realpathSync(plan.trustedParent) !== plan.trustedParent
  )
    throw new Error("trusted output parent changed");
}

function checkControlledRoot(plan: OutputPlan): void {
  checkTrustedParent(plan);
  if (!contained(plan.trustedParent, plan.outDir)) throw new Error("output escapes trusted parent");
  if (!existsSync(plan.outDir)) return;
  const output = lstatSync(plan.outDir);
  if (output.isSymbolicLink()) throw new Error("output root contains a symlink");
  if (!output.isDirectory()) throw new Error("output root is not a directory");
  if (realpathSync(plan.outDir) !== plan.outDir)
    throw new Error("output root escapes trusted parent");
}

export function createOutputPlan(outDir: string): OutputPlan {
  if (!isAbsolute(outDir)) throw new Error("outDir must be absolute");
  const suppliedParent = dirname(resolve(outDir));
  const trustedParent = realpathSync(suppliedParent);
  const parent = statSync(trustedParent);
  if (!parent.isDirectory()) throw new Error("outDir parent must be a directory");
  const planned = join(trustedParent, basename(outDir));
  const result = Object.freeze({
    trustedParent,
    outDir: planned,
    parentDev: parent.dev,
    parentIno: parent.ino,
  });
  checkControlledRoot(result);
  return result;
}

function decodePayloads(payloads: readonly string[]): readonly Buffer[] {
  const decoded: Buffer[] = [];
  let batchBytes = 0;
  for (const payload of payloads) {
    if (payload.length > MAX_DATA_URI_BASE64_CHARS)
      throw new Error("generated image exceeds 20 MiB limit");
    let bytes: Buffer;
    try {
      bytes = decodeStrictBase64(payload);
    } catch {
      throw new Error("invalid base64 image payload");
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("generated image exceeds 20 MiB limit");
    batchBytes += bytes.byteLength;
    if (batchBytes > MAX_IMAGE_BATCH_BYTES)
      throw new Error("generated image batch exceeds 64 MiB limit");
    decoded.push(bytes);
  }
  return decoded;
}

function imageId(source: () => string): string {
  const value = source().replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(value))
    throw new Error("image UUID must be 32 lowercase hex characters");
  return value;
}

interface OwnedPath {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

function sameIdentity(path: string, expected: Pick<OwnedPath, "dev" | "ino">): boolean {
  const current = lstatSync(path);
  return !current.isSymbolicLink() && current.dev === expected.dev && current.ino === expected.ino;
}

/** Remove only exact path+inode pairs created by this operation. */
function removeOwnedPaths(entries: readonly OwnedPath[]): readonly unknown[] {
  const failures: unknown[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      if (sameIdentity(entry.path, entry)) rmSync(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error);
    }
  }
  return failures;
}

function assertRootIdentity(plan: OutputPlan, expected: Pick<Stats, "dev" | "ino">): void {
  checkControlledRoot(plan);
  const current = lstatSync(plan.outDir);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  )
    throw new Error("output root changed after publish hook");
}

async function runPublishHooks(
  plan: OutputPlan,
  finals: readonly string[],
  rootIdentity: Pick<Stats, "dev" | "ino">,
  hook: ((index: number, path: string) => void | Promise<void>) | undefined,
): Promise<void> {
  for (let index = 0; index < finals.length; index += 1) {
    const final = finals[index];
    if (final === undefined) throw new Error("image publish index mismatch");
    await hook?.(index, final);
    assertRootIdentity(plan, rootIdentity);
  }
}

export async function persistGeneratedImages(options: {
  readonly plan: OutputPlan;
  readonly payloads: readonly string[];
  readonly requested: number;
  readonly uuid?: () => string;
  readonly afterRootPreflight?: () => void | Promise<void>;
  readonly beforePublish?: (index: number, path: string) => void | Promise<void>;
  readonly faultAfterBytes?: number;
}): Promise<readonly string[]> {
  if (options.payloads.length > options.requested)
    throw new Error(
      `provider returned ${String(options.payloads.length)} images for requested ${String(options.requested)}`,
    );
  if (options.payloads.length > MAX_IMAGES)
    throw new Error("provider returned more than 10 images");
  const decoded = decodePayloads(options.payloads);
  const uuid = options.uuid ?? (() => randomUUID().replaceAll("-", ""));
  const ids = decoded.map(() => imageId(uuid));
  if (new Set(ids).size !== ids.length) throw new Error("image UUID collision");

  checkControlledRoot(options.plan);
  await options.afterRootPreflight?.();
  try {
    checkControlledRoot(options.plan);
  } catch {
    throw new Error("output root changed after preflight");
  }
  mkdirSync(options.plan.outDir, { recursive: true });
  checkControlledRoot(options.plan);
  const rootIdentity = lstatSync(options.plan.outDir);

  const finals = ids.map((id) => join(options.plan.outDir, `${id}.png`));
  // Hooks are intentionally exhausted before provider bytes exist on disk.
  // The byte-bearing phase below is synchronous and has no external callback.
  await runPublishHooks(options.plan, finals, rootIdentity, options.beforePublish);

  const temps: string[] = [];
  const owned: OwnedPath[] = [];
  try {
    for (let index = 0; index < decoded.length; index += 1) {
      const bytes = decoded[index];
      const final = finals[index];
      if (bytes === undefined || final === undefined)
        throw new Error("image staging index mismatch");
      const temp = join(options.plan.outDir, `.stage-${randomUUID()}.tmp`);
      if (existsSync(final)) throw new Error("image UUID collision");
      const fd = openSync(temp, "wx", 0o600);
      const staged = fstatSync(fd);
      temps.push(temp);
      owned.push({ path: temp, dev: staged.dev, ino: staged.ino });
      try {
        if (options.faultAfterBytes === undefined) writeFileSync(fd, bytes);
        else {
          const written = Math.max(0, Math.min(options.faultAfterBytes, bytes.byteLength));
          writeFileSync(fd, bytes.subarray(0, written));
          throw new Error(`fault after ${String(written)} bytes`);
        }
        fsyncSync(fd);
        fchmodSync(fd, IMAGE_FILE_MODE);
      } finally {
        closeSync(fd);
      }
    }

    for (let index = 0; index < temps.length; index += 1) {
      const temp = temps[index];
      const final = finals[index];
      if (temp === undefined || final === undefined)
        throw new Error("image publish index mismatch");
      assertRootIdentity(options.plan, rootIdentity);
      // Revalidate the exact inode and provider bytes before publishing.
      const staged = owned[index];
      const expectedBytes = decoded[index];
      const current = lstatSync(temp);
      if (
        staged === undefined ||
        expectedBytes === undefined ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== staged.dev ||
        current.ino !== staged.ino ||
        current.size !== expectedBytes.byteLength ||
        !readFileSync(temp).equals(expectedBytes)
      )
        throw new Error("staged image changed after publish hook");
      chmodSync(temp, IMAGE_FILE_MODE);
      renameSync(temp, final);
      owned.push({ path: final, dev: staged.dev, ino: staged.ino });
    }
    return Object.freeze([...finals]);
  } catch (error) {
    let cleanupFailures: readonly unknown[] = [];
    try {
      checkTrustedParent(options.plan);
      cleanupFailures = removeOwnedPaths(owned);
    } catch {
      // Never act on paths below a parent whose identity is no longer trusted.
    }
    if (cleanupFailures.length > 0)
      throw new AggregateError(cleanupFailures, "image cleanup failed", { cause: error });
    throw error;
  }
}
