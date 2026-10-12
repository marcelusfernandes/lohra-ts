import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  prepareWindowsPrivateDestination,
  type WindowsFileProtection,
} from "../security/windows-file-protection.js";

export interface AtomicWriteOperations {
  readonly mkdir: (path: string) => void;
  readonly open: (path: string, flags: "wx" | "r+", mode: number) => number;
  readonly write: (descriptor: number, bytes: Buffer, offset: number) => number;
  readonly fsync: (descriptor: number) => void;
  readonly close: (descriptor: number) => void;
  readonly rename: (source: string, destination: string) => void;
  readonly unlink: (path: string) => void;
  readonly pid: number;
  readonly now: () => number;
  readonly platform?: string;
  readonly prepare?: (
    path: string,
    options?: { readonly exclusive?: boolean; readonly existing?: boolean },
  ) => WindowsFileProtection;
}

const defaultOperations: AtomicWriteOperations = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  open: (path, flags, mode) => openSync(path, flags, mode),
  write: (descriptor, bytes, offset) => writeSync(descriptor, bytes, offset),
  fsync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  unlink: unlinkSync,
  pid: process.pid,
  now: Date.now,
  platform: process.platform,
  prepare: (path, options) => prepareWindowsPrivateDestination(path, undefined, options),
};

function windowsAuthWriteFailure(path: string, cause: unknown): Error {
  return new Error(
    `Could not save private credentials at ${path} — check that the destination is a private fixed NTFS path accessible to your account`,
    { cause },
  );
}

export function atomicWrite0600(
  path: string,
  data: string,
  operations: AtomicWriteOperations = defaultOperations,
): void {
  if ((operations.platform ?? process.platform) === "win32") {
    const prepare =
      operations.prepare ??
      ((target, options) => prepareWindowsPrivateDestination(target, undefined, options));
    let destination: WindowsFileProtection;
    try {
      destination = prepare(path);
    } catch (error) {
      throw windowsAuthWriteFailure(path, error);
    }
    const temporary = `${path}.tmp-${String(operations.pid)}-${String(operations.now())}`;
    let stage: WindowsFileProtection | null = null;
    let descriptor: number | null = null;
    let published = false;
    try {
      stage = prepare(temporary, { exclusive: true });
      descriptor = stage.openOwnedForWrite();
      const bytes = Buffer.from(data, "utf8");
      let offset = 0;
      while (offset < bytes.length) offset += operations.write(descriptor, bytes, offset);
      operations.fsync(descriptor);
      operations.close(descriptor);
      descriptor = null;
      destination.verifyBeforePublication(temporary);
      operations.rename(temporary, path);
      published = true;
      destination.verifyAfterPublication();
      return;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (descriptor !== null) {
        try {
          operations.close(descriptor);
        } catch (closeError) {
          cleanupErrors.push(closeError);
        }
      }
      if (stage !== null && !published) {
        try {
          stage.removeOwned();
        } catch (removeError) {
          cleanupErrors.push(removeError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw windowsAuthWriteFailure(
          path,
          new AggregateError([error, ...cleanupErrors], "Windows auth write and cleanup failed", {
            cause: error,
          }),
        );
      }
      throw windowsAuthWriteFailure(path, error);
    }
  }
  operations.mkdir(dirname(path));
  const temporary = `${path}.tmp-${String(operations.pid)}-${String(operations.now())}`;
  let descriptor: number | null = null;
  try {
    descriptor = operations.open(temporary, "wx", 0o600);
    const bytes = Buffer.from(data, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += operations.write(descriptor, bytes, offset);
    operations.fsync(descriptor);
    operations.close(descriptor);
    descriptor = null;
    operations.rename(temporary, path);
  } catch (error) {
    if (descriptor !== null) operations.close(descriptor);
    try {
      operations.unlink(temporary);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}
