import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { win32 } from "node:path";

import {
  runWindowsAcl,
  runWindowsAclBatch,
  WindowsUnsupportedVolumeError,
  type WindowsAclRequest,
} from "./windows-file-protection-native.js";

type Entry = Readonly<{ kind: "file" | "directory" | "link"; identity: string; size: bigint }>;
type PendingCreation = Readonly<{
  path: string;
  kind: "file" | "directory";
  creation: "attempted" | "confirmed";
}>;

export interface WindowsProtectionOperations {
  readonly platform: string;
  /**
   * True when `protect` also verifies the ACL it applied (the native backend
   * does), so the module rechecks only the identity right after it instead of
   * verifying again. Absent: `protect` is followed by `verify`, as before.
   */
  readonly protectVerifies?: boolean;
  /**
   * Runs the requests in order in one backend round trip (one process). Absent:
   * each request goes through `volume`, `protect` or `verify`, in the same order.
   */
  batch?: (requests: readonly WindowsAclRequest[]) => void;
  volume(path: string): void;
  inspect(path: string): Entry | null;
  mkdir(path: string): void;
  createEmpty(path: string): void;
  openWrite(path: string): number;
  descriptorIdentity(descriptor: number): string;
  close(descriptor: number): void;
  protect(path: string): void;
  verify(path: string): void;
  verifyMany?: (paths: readonly string[]) => void;
  removeFile(path: string): void;
  removeDirectory(path: string): void;
}

export interface WindowsFileProtection {
  verifyBeforeWrite(): void;
  openOwnedForWrite(): number;
  verifyBeforePublication(source: string): void;
  verifyAfterPublication(): void;
  removeOwned(): void;
}

const nativeOperations: WindowsProtectionOperations = {
  platform: process.platform,
  volume: (path) => {
    runWindowsAcl("volume", path);
  },
  inspect: (path) => {
    try {
      const stat = lstatSync(path, { bigint: true });
      if (stat.ino === 0n) throw new Error(`Windows file identity unavailable: ${path}`);
      if (!stat.isSymbolicLink() && !stat.isDirectory() && !stat.isFile()) {
        throw new Error(`Windows path is not a regular file or directory: ${path}`);
      }
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
      return { kind, identity: `${String(stat.dev)}:${String(stat.ino)}`, size: stat.size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },
  mkdir: (path) => {
    mkdirSync(path);
  },
  createEmpty: (path) => {
    closeSync(openSync(path, "wx", 0o600));
  },
  openWrite: (path) => openSync(path, "r+"),
  descriptorIdentity: (descriptor) => {
    const stat = fstatSync(descriptor, { bigint: true });
    return `${String(stat.dev)}:${String(stat.ino)}`;
  },
  close: closeSync,
  protect: (path) => {
    runWindowsAcl("protect", path);
  },
  verify: (path) => {
    runWindowsAcl("verify", path);
  },
  verifyMany: (paths) => {
    runWindowsAclBatch(paths.map((path) => ({ action: "verify", path })));
  },
  removeFile: unlinkSync,
  removeDirectory: rmdirSync,
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Why a path cannot be a private destination, or null when it can. */
function pathRefusal(path: string): string | null {
  if (!/^[A-Za-z]:\\/.test(path) || !win32.isAbsolute(path)) {
    return "Windows private destination requires an absolute local drive path";
  }
  if (win32.normalize(path) !== path || path.includes("/") || path.includes("\0")) {
    return "Windows private destination has an ambiguous path";
  }
  const segments = path.slice(3).split("\\");
  if (
    segments.some(
      (segment) =>
        !segment ||
        /[:. ]$/.test(segment) ||
        segment.includes(":") ||
        /~[0-9]/.test(segment) ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment),
    )
  ) {
    return "Windows private destination has an ambiguous path component";
  }
  return null;
}

function validPath(path: string): string {
  const refusal = pathRefusal(path);
  if (refusal !== null) throw new Error(refusal);
  return path;
}

function inspectChain(path: string, operations: WindowsProtectionOperations): Entry | null {
  const root = win32.parse(path).root;
  let cursor = root;
  const parts = path.slice(root.length).split("\\");
  for (const [index, part] of parts.entries()) {
    cursor = win32.join(cursor, part);
    const entry = operations.inspect(cursor);
    if (!entry) {
      if (index !== parts.length - 1) throw new Error(`Missing Windows path ancestor: ${cursor}`);
      return null;
    }
    if (entry.kind === "link")
      throw new Error(`Windows reparse point is not verifiable: ${cursor}`);
    if (index !== parts.length - 1 && entry.kind !== "directory") {
      throw new Error(`Windows path ancestor is not a directory: ${cursor}`);
    }
    if (index === parts.length - 1) return entry;
  }
  return null;
}

function checked(
  path: string,
  kind: Entry["kind"],
  identity: string,
  operations: WindowsProtectionOperations,
): Entry {
  const entry = checkedMany([{ path, kind, identity }], operations)[0];
  if (!entry) throw new Error(`Windows destination cannot be inspected: ${path}`);
  return entry;
}

function checkedMany(
  expected: ReadonlyArray<Readonly<{ path: string; kind: Entry["kind"]; identity: string }>>,
  operations: WindowsProtectionOperations,
): Entry[] {
  if (expected.length < 1 || expected.length > 3)
    throw new Error("Windows ACL verification group must contain one to three paths");
  for (const { path, kind, identity } of expected) {
    const before = inspectChain(path, operations);
    if (!before || before.kind !== kind || before.identity !== identity) {
      throw new Error(`Windows destination identity changed: ${path}`);
    }
  }
  if (operations.verifyMany) operations.verifyMany(expected.map(({ path }) => path));
  else for (const { path } of expected) operations.verify(path);
  return expected.map(({ path, kind, identity }) => {
    const after = inspectChain(path, operations);
    if (!after || after.kind !== kind || after.identity !== identity) {
      throw new Error(`Windows destination identity changed during ACL verification: ${path}`);
    }
    return after;
  });
}

function cleanOwn(
  owned: ReadonlyArray<Readonly<{ path: string; entry: Entry }>>,
  unverified: PendingCreation | null,
  operations: WindowsProtectionOperations,
  primary: unknown,
): never {
  const cleanupErrors: unknown[] = [];
  if (unverified) {
    cleanupErrors.push(
      new Error(
        unverified.creation === "confirmed"
          ? `Windows cleanup inconclusive: identity unverified for created ${unverified.kind}; retained ${unverified.path}`
          : `Windows cleanup inconclusive: identity unverified after attempted ${unverified.kind} creation; possible residual at ${unverified.path}`,
      ),
    );
  }
  for (const { path, entry } of [...owned].reverse()) {
    try {
      if (unverified && (unverified.path === path || unverified.path.startsWith(`${path}\\`))) {
        throw new Error(`Windows cleanup skipped for ${path}: contains an unverified created path`);
      }
      const current = operations.inspect(path);
      if (!current || current.identity !== entry.identity || current.kind !== entry.kind) {
        throw new Error(`Refusing cleanup after Windows path identity changed: ${path}`);
      }
      if (entry.kind === "file") operations.removeFile(path);
      else operations.removeDirectory(path);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError([primary, ...cleanupErrors], "Windows protection and cleanup failed", {
      cause: primary,
    });
  }
  throw primary;
}

/** False only when the path or the volume is one where protection cannot apply. */
function canBeProtected(target: string, operations: WindowsProtectionOperations): boolean {
  if (pathRefusal(target) !== null) return false;
  try {
    operations.volume(target);
    return true;
  } catch (error) {
    if (error instanceof WindowsUnsupportedVolumeError) return false;
    throw error;
  }
}

/** What `mkdirSync(target, { recursive: true })` did before: no ACL work at all. */
function createUnprotected(target: string, operations: WindowsProtectionOperations): void {
  const root = win32.parse(target).root;
  let cursor = root;
  for (const part of target.slice(root.length).split("\\")) {
    cursor = win32.join(cursor, part);
    if (operations.inspect(cursor)) continue;
    try {
      operations.mkdir(cursor);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
}

/**
 * Creates the Lohra home or profile directory already protected, so the first
 * credential written there finds a directory that passes verification. Each
 * missing level (top-down) is created, protected and verified before the next
 * one. A level that already exists is never inspected for ACL nor modified
 * (ADR 0006): the sensitive write verifies it and refuses an incompatible one.
 * On failure only what this call created is removed, and the primary cause is
 * kept. A path or volume that cannot be protected (8.3 or ambiguous component,
 * UNC, a volume that is not fixed NTFS) is created unprotected, as before, so
 * the commands that hold no credential keep opening; the credential write there
 * stays refused by prepareWindowsPrivateDestination. Any other failure of the
 * checks propagates. Path-based like the rest of this module: concurrent
 * replacement still requires the caller-held lease/fence.
 */
export function ensureWindowsPrivateDirectory(
  directory: string,
  operations: WindowsProtectionOperations = nativeOperations,
): void {
  if (operations.platform !== "win32") throw new Error("Windows file protection requires Windows");
  const target = win32.resolve(directory);
  if (operations.inspect(target)) return;
  let protectable: boolean;
  try {
    protectable = canBeProtected(target, operations);
  } catch (error) {
    throw new Error(`Could not create a private Windows directory at ${target}`, { cause: error });
  }
  if (!protectable) {
    createUnprotected(target, operations);
    return;
  }
  const owned: Array<{ path: string; entry: Entry }> = [];
  let unverified: PendingCreation | null = null;
  try {
    const root = win32.parse(target).root;
    let cursor = root;
    for (const part of target.slice(root.length).split("\\")) {
      cursor = win32.join(cursor, part);
      if (inspectChain(cursor, operations)) continue;
      unverified = { path: cursor, kind: "directory", creation: "attempted" };
      try {
        operations.mkdir(cursor);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        // Another process created it first: not ours, never protect or remove.
        unverified = null;
        continue;
      }
      unverified = { path: cursor, kind: "directory", creation: "confirmed" };
      const created = inspectChain(cursor, operations);
      if (!created) throw new Error(`Created Windows directory cannot be inspected: ${cursor}`);
      owned.push({ path: cursor, entry: created });
      unverified = null;
      operations.protect(cursor);
      checked(cursor, "directory", created.identity, operations);
    }
  } catch (error) {
    try {
      cleanOwn(owned, unverified, operations, error);
    } catch (failure) {
      throw new Error(`Could not create a private Windows directory at ${target}`, {
        cause: failure,
      });
    }
  }
}

/**
 * Creates an empty destination or verifies an existing protected destination.
 * Direct writing requires empty; a nonempty destination can only be replaced
 * through caller-owned rename of a verified protected sibling. Each check is
 * path-based; concurrent replacement after a check still requires a caller-held
 * lease/fence. openOwnedForWrite binds the first write to the inspected file
 * descriptor, but cannot make later path checks atomic with another process.
 * Native ACL checks are metadata checks, not cross-token access proof.
 */
export function prepareWindowsPrivateDestination(
  destination: string,
  operations: WindowsProtectionOperations = nativeOperations,
  options: { readonly exclusive?: boolean; readonly existing?: boolean } = {},
): WindowsFileProtection {
  if (options.exclusive && options.existing)
    throw new Error("Windows destination cannot require both exclusive and existing modes");
  const file = validPath(destination);
  if (operations.platform !== "win32") throw new Error("Windows file protection requires Windows");
  const directory = win32.dirname(file);
  if (directory === file) throw new Error("Windows private destination requires a file name");
  operations.volume(file);
  const owned: Array<{ path: string; entry: Entry }> = [];
  let unverified: PendingCreation | null = null;
  let exclusiveContention = false;
  try {
    let dirEntry = inspectChain(directory, operations);
    if (!dirEntry && options.existing) {
      throw Object.assign(new Error(`Windows private destination is missing: ${file}`), {
        code: "ENOENT",
      });
    }
    if (!dirEntry) {
      unverified = { path: directory, kind: "directory", creation: "attempted" };
      operations.mkdir(directory);
      unverified = { path: directory, kind: "directory", creation: "confirmed" };
      dirEntry = inspectChain(directory, operations);
      if (!dirEntry) throw new Error(`Created Windows directory cannot be inspected: ${directory}`);
      owned.push({ path: directory, entry: dirEntry });
      unverified = null;
      operations.protect(directory);
    }
    if (dirEntry.kind !== "directory")
      throw new Error(`Windows private path is not a directory: ${directory}`);
    checked(directory, "directory", dirEntry.identity, operations);

    let fileEntry = inspectChain(file, operations);
    const createdFile = fileEntry === null;
    if (options.exclusive && fileEntry) {
      // The other creator may still be applying its ACL. EEXIST means only
      // that this exclusive create lost; it grants no guard over that file.
      exclusiveContention = true;
      throw Object.assign(new Error(`Windows private destination already exists: ${file}`), {
        code: "EEXIST",
      });
    }
    if (options.existing && createdFile) {
      throw Object.assign(new Error(`Windows private destination is missing: ${file}`), {
        code: "ENOENT",
      });
    }
    if (!fileEntry) {
      unverified = { path: file, kind: "file", creation: "attempted" };
      try {
        operations.createEmpty(file);
      } catch (error) {
        if (options.exclusive && isCode(error, "EEXIST")) {
          // wx established contention; never inspect ACL, own or clean the
          // file created by the winner while its protection is incomplete.
          unverified = null;
          exclusiveContention = true;
        }
        throw error;
      }
      unverified = { path: file, kind: "file", creation: "confirmed" };
      fileEntry = inspectChain(file, operations);
      if (!fileEntry) throw new Error(`Created Windows file cannot be inspected: ${file}`);
      owned.push({ path: file, entry: fileEntry });
      unverified = null;
      operations.protect(file);
    }
    if (fileEntry.kind !== "file") {
      throw new Error(`Windows private destination must be a regular file: ${file}`);
    }
    checked(file, "file", fileEntry.identity, operations);
    const directoryIdentity = dirEntry.identity;
    const destinationIdentity = fileEntry.identity;
    let stagedIdentity: string | null = null;
    let stagedPath: string | null = null;
    return {
      verifyBeforeWrite: () => {
        const [, entry] = checkedMany(
          [
            { path: directory, kind: "directory", identity: directoryIdentity },
            { path: file, kind: "file", identity: destinationIdentity },
          ],
          operations,
        );
        if (!entry) throw new Error(`Windows destination cannot be inspected: ${file}`);
        if (entry.size !== 0n) throw new Error(`Windows destination is no longer empty: ${file}`);
      },
      openOwnedForWrite: () => {
        const [, entry] = checkedMany(
          [
            { path: directory, kind: "directory", identity: directoryIdentity },
            { path: file, kind: "file", identity: destinationIdentity },
          ],
          operations,
        );
        if (!entry) throw new Error(`Windows destination cannot be inspected: ${file}`);
        if (entry.size !== 0n) throw new Error(`Windows destination is no longer empty: ${file}`);
        const descriptor = operations.openWrite(file);
        try {
          if (operations.descriptorIdentity(descriptor) !== destinationIdentity) {
            throw new Error(`Windows open file identity changed: ${file}`);
          }
          const current = inspectChain(file, operations);
          if (!current || current.identity !== destinationIdentity || current.kind !== "file") {
            throw new Error(`Windows destination identity changed after open: ${file}`);
          }
          return descriptor;
        } catch (error) {
          let closeFailure: unknown;
          let closeFailed = false;
          try {
            operations.close(descriptor);
          } catch (closeError) {
            closeFailure = closeError;
            closeFailed = true;
          }
          if (closeFailed) {
            throw new AggregateError([error, closeFailure], "Windows open and close failed", {
              cause: error,
            });
          }
          throw error;
        }
      },
      verifyBeforePublication: (source) => {
        const stage = validPath(source);
        if (
          win32.dirname(stage).toLowerCase() !== directory.toLowerCase() ||
          stage.toLowerCase() === file.toLowerCase()
        ) {
          throw new Error("Windows publication source must be a distinct sibling");
        }
        const sourceEntry = inspectChain(stage, operations);
        if (!sourceEntry || sourceEntry.kind !== "file")
          throw new Error("Windows publication source is not a regular file");
        if (sourceEntry.identity === destinationIdentity)
          throw new Error("Windows publication source aliases destination");
        checkedMany(
          [
            { path: directory, kind: "directory", identity: directoryIdentity },
            { path: file, kind: "file", identity: destinationIdentity },
            { path: stage, kind: "file", identity: sourceEntry.identity },
          ],
          operations,
        );
        stagedIdentity = sourceEntry.identity;
        stagedPath = stage;
      },
      verifyAfterPublication: () => {
        if (!stagedIdentity || !stagedPath)
          throw new Error("Windows publication was not verified before rename");
        checkedMany(
          [
            { path: directory, kind: "directory", identity: directoryIdentity },
            { path: file, kind: "file", identity: stagedIdentity },
          ],
          operations,
        );
        if (inspectChain(stagedPath, operations))
          throw new Error("Windows publication source still exists");
      },
      removeOwned: () => {
        if (!createdFile) throw new Error(`Windows private destination is not owned: ${file}`);
        checked(file, "file", destinationIdentity, operations);
        operations.removeFile(file);
      },
    };
  } catch (error) {
    if (exclusiveContention) throw error;
    cleanOwn(owned, unverified, operations, error);
  }
}
