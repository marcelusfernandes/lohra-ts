import { closeSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import { win32 } from "node:path";

import { runWindowsAcl } from "./windows-file-protection-native.js";

type Entry = Readonly<{ kind: "file" | "directory" | "link"; identity: string; size: bigint }>;
type PendingCreation = Readonly<{
  path: string;
  kind: "file" | "directory";
  creation: "attempted" | "confirmed";
}>;

export interface WindowsProtectionOperations {
  readonly platform: string;
  volume(path: string): void;
  inspect(path: string): Entry | null;
  mkdir(path: string): void;
  createEmpty(path: string): void;
  protect(path: string): void;
  verify(path: string): void;
  removeFile(path: string): void;
  removeDirectory(path: string): void;
}

export interface WindowsFileProtection {
  verifyBeforeWrite(): void;
  verifyBeforePublication(source: string): void;
  verifyAfterPublication(): void;
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
  protect: (path) => {
    runWindowsAcl("protect", path);
  },
  verify: (path) => {
    runWindowsAcl("verify", path);
  },
  removeFile: unlinkSync,
  removeDirectory: rmdirSync,
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validPath(path: string): string {
  if (!/^[A-Za-z]:\\/.test(path) || !win32.isAbsolute(path)) {
    throw new Error("Windows private destination requires an absolute local drive path");
  }
  if (win32.normalize(path) !== path || path.includes("/") || path.includes("\0")) {
    throw new Error("Windows private destination has an ambiguous path");
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
    throw new Error("Windows private destination has an ambiguous path component");
  }
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
  const before = inspectChain(path, operations);
  if (!before || before.kind !== kind || before.identity !== identity) {
    throw new Error(`Windows destination identity changed: ${path}`);
  }
  operations.verify(path);
  const after = inspectChain(path, operations);
  if (!after || after.kind !== kind || after.identity !== identity) {
    throw new Error(`Windows destination identity changed during ACL verification: ${path}`);
  }
  return after;
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

/**
 * Creates an empty destination or verifies an existing protected destination.
 * Direct writing requires empty; a nonempty destination can only be replaced
 * through caller-owned rename of a verified protected sibling. Each check is
 * path-based; concurrent replacement after a check still requires a caller-held
 * lease/fence. Native ACL checks are metadata checks, not cross-token access proof.
 */
export function prepareWindowsPrivateDestination(
  destination: string,
  operations: WindowsProtectionOperations = nativeOperations,
): WindowsFileProtection {
  const file = validPath(destination);
  if (operations.platform !== "win32") throw new Error("Windows file protection requires Windows");
  const directory = win32.dirname(file);
  if (directory === file) throw new Error("Windows private destination requires a file name");
  operations.volume(file);
  const owned: Array<{ path: string; entry: Entry }> = [];
  let unverified: PendingCreation | null = null;
  try {
    let dirEntry = inspectChain(directory, operations);
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
    if (!fileEntry) {
      unverified = { path: file, kind: "file", creation: "attempted" };
      operations.createEmpty(file);
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
        checked(directory, "directory", directoryIdentity, operations);
        const entry = checked(file, "file", destinationIdentity, operations);
        if (entry.size !== 0n) throw new Error(`Windows destination is no longer empty: ${file}`);
      },
      verifyBeforePublication: (source) => {
        const stage = validPath(source);
        if (
          win32.dirname(stage).toLowerCase() !== directory.toLowerCase() ||
          stage.toLowerCase() === file.toLowerCase()
        ) {
          throw new Error("Windows publication source must be a distinct sibling");
        }
        checked(directory, "directory", directoryIdentity, operations);
        checked(file, "file", destinationIdentity, operations);
        const sourceEntry = inspectChain(stage, operations);
        if (!sourceEntry || sourceEntry.kind !== "file")
          throw new Error("Windows publication source is not a regular file");
        if (sourceEntry.identity === destinationIdentity)
          throw new Error("Windows publication source aliases destination");
        checked(stage, "file", sourceEntry.identity, operations);
        stagedIdentity = sourceEntry.identity;
        stagedPath = stage;
      },
      verifyAfterPublication: () => {
        if (!stagedIdentity || !stagedPath)
          throw new Error("Windows publication was not verified before rename");
        checked(directory, "directory", directoryIdentity, operations);
        checked(file, "file", stagedIdentity, operations);
        if (inspectChain(stagedPath, operations))
          throw new Error("Windows publication source still exists");
      },
    };
  } catch (error) {
    cleanOwn(owned, unverified, operations, error);
  }
}
