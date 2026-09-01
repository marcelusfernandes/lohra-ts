import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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

function checkControlledRoot(plan: OutputPlan): void {
  const parent = statSync(plan.trustedParent);
  if (
    !parent.isDirectory() ||
    !identity(parent, plan) ||
    realpathSync(plan.trustedParent) !== plan.trustedParent
  )
    throw new Error("trusted output parent changed");
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

function strictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const firstPadding = value.indexOf("=");
  const bodyEnd = firstPadding === -1 ? value.length : firstPadding;
  const padding = value.length - bodyEnd;
  if (padding > 2) return false;
  for (let index = bodyEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  for (let index = 0; index < bodyEnd; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  return true;
}

function decodePayloads(payloads: readonly string[]): readonly Buffer[] {
  const decoded: Buffer[] = [];
  let batchBytes = 0;
  for (const payload of payloads) {
    if (payload.length > MAX_DATA_URI_BASE64_CHARS)
      throw new Error("generated image exceeds 20 MiB limit");
    if (!strictBase64(payload)) throw new Error("invalid base64 image payload");
    const bytes = Buffer.from(payload, "base64");
    if (bytes.toString("base64") !== payload) throw new Error("invalid base64 image payload");
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

export async function persistGeneratedImages(options: {
  readonly plan: OutputPlan;
  readonly payloads: readonly string[];
  readonly requested: number;
  readonly uuid?: () => string;
  readonly afterRootPreflight?: () => void | Promise<void>;
  readonly beforePublish?: (index: number, path: string) => void | Promise<void>;
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

  const temps: string[] = [];
  const finals: string[] = [];
  try {
    for (let index = 0; index < decoded.length; index += 1) {
      const bytes = decoded[index];
      const id = ids[index];
      if (bytes === undefined || id === undefined) throw new Error("image staging index mismatch");
      const temp = join(options.plan.outDir, `.${id}.tmp`);
      const final = join(options.plan.outDir, `${id}.png`);
      if (existsSync(final)) throw new Error("image UUID collision");
      const fd = openSync(temp, "wx", 0o600);
      temps.push(temp);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
        chmodSync(temp, IMAGE_FILE_MODE);
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
      renameSync(temp, final);
    }
    return Object.freeze([...finals]);
  } catch (error) {
    let rootSafe = false;
    try {
      checkControlledRoot(options.plan);
      rootSafe = true;
    } catch {
      // Never follow a root that failed containment merely to clean up.
    }
    if (rootSafe) {
      const cleanupErrors: unknown[] = [];
      for (const path of [...temps, ...finals]) {
        try {
          rmSync(path, { force: true });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0)
        throw new Error(`image cleanup failed for ${String(cleanupErrors.length)} paths`, {
          cause: error,
        });
    }
    throw error;
  }
}
