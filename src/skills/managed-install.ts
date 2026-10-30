import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, relative, resolve } from "node:path";

import { MANAGED_SKILL_NAME } from "./clients.js";
import { readExportable } from "./export.js";
import {
  checkEntry,
  ManagedInstallError,
  physicalDirectory,
  publish,
  underLock,
  type InstallFs,
} from "./managed-install-paths.js";
export { ManagedInstallError } from "./managed-install-paths.js";

export type ManagedInstallStatus = "installed" | "updated" | "removed" | "noop";
export interface ManagedInstallResult {
  readonly status: ManagedInstallStatus;
  readonly directory: string;
  readonly preservedExtras: readonly string[];
}
export interface ManagedInstallOperations {
  readonly fs: InstallFs;
  readonly readKit: () => string;
}
const FILE = "SKILL.md";
const MARKER = ".lohra-managed.json";
const MAX_BYTES = 256_000;
function hash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
function read(path: string, limit: number, io: InstallFs): string {
  const entry = checkEntry(path, "file", io);
  if (!entry || entry.size > limit)
    throw new ManagedInstallError("conflict", `missing or oversized managed file: ${path}`);
  return io.readFileSync(path, "utf8");
}
function recordedHash(path: string, io: InstallFs): string {
  try {
    const value: unknown = JSON.parse(read(path, 4096, io));
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (
        record.schema === 1 &&
        record.owner === "lohra-ts" &&
        record.kit === MANAGED_SKILL_NAME &&
        record.file === FILE &&
        typeof record.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(record.sha256)
      )
        return record.sha256;
    }
    throw new Error("invalid managed skill ownership schema");
  } catch (cause) {
    if (cause instanceof ManagedInstallError && cause.code === "unsafe-path") throw cause;
    throw new ManagedInstallError(
      "conflict",
      "invalid ownership record; preserving installation",
      cause,
    );
  }
}
function perform(
  action: "add" | "remove",
  root: string,
  io: InstallFs,
  readKit: () => string,
): ManagedInstallResult {
  const directory = join(root, MANAGED_SKILL_NAME);
  if (relative(root, directory) !== MANAGED_SKILL_NAME)
    throw new ManagedInstallError("unsafe-path", "managed destination escaped skills root");
  const file = join(directory, FILE);
  const marker = join(directory, MARKER);
  const directoryExists = checkEntry(directory, "directory", io) !== undefined;
  const entries = directoryExists ? io.readdirSync(directory) : [];
  if (entries.length > 128)
    throw new ManagedInstallError(
      "conflict",
      "managed directory entry limit exceeded; preserving all files",
    );
  const extras = entries.filter((name) => name !== FILE && name !== MARKER).sort();
  const result = (status: ManagedInstallStatus): ManagedInstallResult => ({
    status,
    directory,
    preservedExtras: [...extras],
  });
  const fileExists = checkEntry(file, "file", io) !== undefined;
  const markerExists = checkEntry(marker, "file", io) !== undefined;
  if (action === "remove" && !fileExists && !markerExists) return result("noop");
  if (directoryExists) {
    if (
      !fileExists ||
      !markerExists ||
      hash(read(file, MAX_BYTES, io)) !== recordedHash(marker, io)
    ) {
      throw new ManagedInstallError(
        "conflict",
        "unmanaged, edited, or partial installation; preserving all files",
      );
    }
  }
  const body = action === "add" ? readKit() : "";
  if (Buffer.byteLength(body, "utf8") > MAX_BYTES)
    throw new ManagedInstallError("conflict", "bundled skill size limit exceeded");
  if (action === "add" && directoryExists && hash(body) === recordedHash(marker, io))
    return result("noop");
  let changed = false;
  try {
    // All paths are fixed constants, never paths supplied by an ownership record.
    checkEntry(directory, "directory", io);
    if (action === "remove") {
      checkEntry(file, "file", io);
      checkEntry(marker, "file", io);
      io.unlinkSync(file);
      changed = true;
      io.unlinkSync(marker);
      if (!extras.length) io.rmdirSync(directory);
      return result("removed");
    }
    if (!directoryExists) {
      io.mkdirSync(directory);
      changed = true;
    }
    publish(file, body, io);
    changed = true;
    publish(
      marker,
      JSON.stringify({
        schema: 1,
        owner: "lohra-ts",
        kit: MANAGED_SKILL_NAME,
        file: FILE,
        sha256: hash(body),
      }) + "\n",
      io,
    );
    return result(directoryExists ? "updated" : "installed");
  } catch (cause) {
    throw new ManagedInstallError(
      changed ? "partial" : "io",
      changed
        ? "managed skill operation may be partial; inspect ownership/content before retrying"
        : "managed skill operation failed before publication",
      cause,
    );
  }
}
/** Sync, single-kit operation. Locks coordinate Lohra writers, not hostile owners. */
export function manageSkillInstallation(
  request: { readonly action: "add" | "remove"; readonly skillsDirectory: string },
  operations: Partial<ManagedInstallOperations> = {},
): ManagedInstallResult {
  const io = operations.fs ?? fs;
  try {
    const root = physicalDirectory(request.skillsDirectory, request.action === "add", io);
    if (!root)
      return {
        status: "noop",
        directory: join(resolve(request.skillsDirectory), MANAGED_SKILL_NAME),
        preservedExtras: [],
      };
    return underLock(root, io, () =>
      perform(
        request.action,
        root,
        io,
        operations.readKit ?? (() => readExportable(MANAGED_SKILL_NAME)),
      ),
    );
  } catch (cause) {
    if (cause instanceof ManagedInstallError) throw cause;
    throw new ManagedInstallError("io", "managed skill operation failed", cause);
  }
}
