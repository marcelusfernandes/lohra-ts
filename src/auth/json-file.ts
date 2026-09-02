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

export interface AtomicWriteOperations {
  readonly mkdir: (path: string) => void;
  readonly open: (path: string, flags: "wx", mode: number) => number;
  readonly write: (descriptor: number, bytes: Buffer, offset: number) => number;
  readonly fsync: (descriptor: number) => void;
  readonly close: (descriptor: number) => void;
  readonly rename: (source: string, destination: string) => void;
  readonly unlink: (path: string) => void;
  readonly pid: number;
  readonly now: () => number;
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
};

export function atomicWrite0600(
  path: string,
  data: string,
  operations: AtomicWriteOperations = defaultOperations,
): void {
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
