import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

/**
 * Remove every pathname below the trusted parent that references an inode
 * owned by this operation. The traversal never follows symlinks, is not depth
 * limited, and deliberately does not stop at the first hardlink. That makes a
 * hook-visible relocation or alias set cleanable without deleting by name.
 */
function removeOwnedLinks(
  plan: OutputPlan,
  entries: readonly { readonly dev: number; readonly ino: number }[],
): void {
  const ownedIdentities = new Set(
    entries.map((entry) => `${String(entry.dev)}:${String(entry.ino)}`),
  );
  if (ownedIdentities.size === 0) return;
  const pending = [plan.trustedParent];
  const visitedDirectories = new Set<string>();

  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    const directoryStats = lstatSync(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) continue;
    const directoryIdentity = `${String(directoryStats.dev)}:${String(directoryStats.ino)}`;
    if (visitedDirectories.has(directoryIdentity)) continue;
    visitedDirectories.add(directoryIdentity);

    for (const name of readdirSync(directory)) {
      const candidatePath = join(directory, name);
      let candidate: Stats;
      try {
        candidate = lstatSync(candidatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (candidate.isSymbolicLink()) continue;
      if (candidate.isDirectory()) {
        pending.push(candidatePath);
        continue;
      }
      if (ownedIdentities.has(`${String(candidate.dev)}:${String(candidate.ino)}`))
        rmSync(candidatePath, { force: true });
    }
  }
}

export async function persistGeneratedImages(options: {
  readonly plan: OutputPlan;
  readonly payloads: readonly string[];
  readonly requested: number;
  readonly uuid?: () => string;
  readonly afterRootPreflight?: () => void | Promise<void>;
  readonly beforePublish?: (index: number, path: string) => void | Promise<void>;
  readonly writeStage?: (fd: number, bytes: Buffer) => void;
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

  const temps: string[] = [];
  const finals: string[] = [];
  const owned: Array<{ readonly dev: number; readonly ino: number }> = [];
  try {
    for (let index = 0; index < decoded.length; index += 1) {
      const bytes = decoded[index];
      const id = ids[index];
      if (bytes === undefined || id === undefined) throw new Error("image staging index mismatch");
      const final = join(options.plan.outDir, `${id}.png`);
      const temp = join(options.plan.outDir, `.stage-${randomUUID()}.tmp`);
      if (existsSync(final)) throw new Error("image UUID collision");
      const fd = openSync(temp, "wx", 0o600);
      const staged = fstatSync(fd);
      temps.push(temp);
      owned.push({ dev: staged.dev, ino: staged.ino });
      try {
        (
          options.writeStage ??
          ((target, value) => {
            writeFileSync(target, value);
          })
        )(fd, bytes);
        fsyncSync(fd);
        fchmodSync(fd, IMAGE_FILE_MODE);
      } finally {
        closeSync(fd);
      }
      finals.push(final);
    }

    for (let index = 0; index < temps.length; index += 1) {
      const temp = temps[index];
      const final = finals[index];
      if (temp === undefined || final === undefined)
        throw new Error("image publish index mismatch");
      await options.beforePublish?.(index, final);
      checkControlledRoot(options.plan);
      const rootNow = lstatSync(options.plan.outDir);
      if (
        rootNow.isSymbolicLink() ||
        !rootNow.isDirectory() ||
        rootNow.dev !== rootIdentity.dev ||
        rootNow.ino !== rootIdentity.ino
      )
        throw new Error("output root changed after publish hook");
      // The hook no longer owns the stage path: revalidate identity, type,
      // size and bytes so a swapped/symlinked/tampered stage can never be
      // published under the provider's name, and restabilize the mode the
      // contract requires.
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
      linkSync(temp, final);
      const linked = lstatSync(final);
      owned.push({ dev: linked.dev, ino: linked.ino });
      rmSync(temp);
    }
    return Object.freeze([...finals]);
  } catch (error) {
    let parentSafe = false;
    try {
      checkTrustedParent(options.plan);
      parentSafe = true;
    } catch {
      // Never traverse a parent whose identity is no longer trusted.
    }
    if (parentSafe) {
      try {
        removeOwnedLinks(options.plan, owned);
      } catch {
        throw new Error("image cleanup failed", {
          cause: error,
        });
      }
    }
    throw error;
  }
}
