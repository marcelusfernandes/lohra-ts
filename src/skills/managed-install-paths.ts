import { randomUUID } from "node:crypto";
import type * as fs from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export type InstallFs = Pick<
  typeof fs,
  | "lstatSync"
  | "realpathSync"
  | "mkdirSync"
  | "openSync"
  | "closeSync"
  | "fstatSync"
  | "writeFileSync"
  | "readFileSync"
  | "fsyncSync"
  | "renameSync"
  | "unlinkSync"
  | "rmdirSync"
  | "readdirSync"
>;
export class ManagedInstallError extends Error {
  constructor(
    readonly code: "conflict" | "unsafe-path" | "busy" | "io" | "partial",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
export function inspect(path: string, io: InstallFs): fs.Stats | undefined {
  try {
    return io.lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}
export function checkEntry(
  path: string,
  kind: "file" | "directory",
  io: InstallFs,
): fs.Stats | undefined {
  const entry = inspect(path, io);
  if (
    entry &&
    (entry.isSymbolicLink() || (kind === "file" ? !entry.isFile() : !entry.isDirectory()))
  ) {
    throw new ManagedInstallError(
      "unsafe-path",
      `refusing non-${kind} or linked managed path: ${path}`,
    );
  }
  return entry;
}
/** No symlink traversal, including existing ancestors of a not-yet-created root. */
export function physicalDirectory(
  path: string,
  create: boolean,
  io: InstallFs,
): string | undefined {
  if (!isAbsolute(path) || resolve(path) === parse(resolve(path)).root) {
    throw new ManagedInstallError(
      "unsafe-path",
      "skills destination must be an absolute non-root directory",
    );
  }
  const root = resolve(path);
  for (let current = root; ; current = dirname(current)) {
    checkEntry(current, "directory", io);
    if (dirname(current) === current) break;
  }
  if (create) io.mkdirSync(root, { recursive: true });
  if (!checkEntry(root, "directory", io)) return undefined;
  return io.realpathSync(root);
}
function collect(errors: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    errors.push(cause);
  }
}
/** Exclusive lock, one attempt, no expiry or automatic recovery of orphan locks. */
export function underLock<T>(root: string, io: InstallFs, operation: () => T): T {
  const path = join(root, ".use-lohra-ts.lohra.lock");
  checkEntry(path, "file", io);
  let descriptor: number;
  try {
    descriptor = io.openSync(path, "wx", 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ManagedInstallError(
        "busy",
        "skill installation is locked; no automatic lock takeover",
        cause,
      );
    }
    throw cause;
  }
  let identity: fs.Stats | undefined;
  let value: T | undefined;
  let failed = false;
  let primary: unknown;
  try {
    identity = io.fstatSync(descriptor);
    io.writeFileSync(descriptor, JSON.stringify({ holder: randomUUID() }), "utf8");
    value = operation();
  } catch (cause) {
    failed = true;
    primary = cause;
  }
  const errors: unknown[] = [];
  collect(errors, () => {
    io.closeSync(descriptor);
  });
  collect(errors, () => {
    const current = checkEntry(path, "file", io);
    if (!identity || !current || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("lock identity changed or could not be established; preserving lock");
    }
    io.unlinkSync(path);
  });
  if (errors.length) {
    throw new ManagedInstallError(
      "io",
      "skill operation or lock cleanup failed; inspect destination and lock before retrying",
      new AggregateError(
        failed ? [primary, ...errors] : errors,
        "managed skill operation and cleanup causes",
        { cause: primary },
      ),
    );
  }
  if (failed) throw primary;
  return value as T;
}
/** Publish only a fixed managed filename; cleanup touches only our exclusive temp. */
export function publish(path: string, body: string, io: InstallFs): void {
  const temporary = `${path}.lohra-${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = io.openSync(temporary, "wx", 0o600);
    created = true;
    io.writeFileSync(descriptor, body, "utf8");
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = undefined;
    checkEntry(path, "file", io);
    io.renameSync(temporary, path);
  } catch (cause) {
    const errors: unknown[] = [];
    if (descriptor !== undefined) {
      const opened = descriptor;
      collect(errors, () => {
        io.closeSync(opened);
      });
    }
    if (created)
      collect(errors, () => {
        try {
          io.unlinkSync(temporary);
        } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw cleanup;
        }
      });
    if (errors.length)
      throw new AggregateError([cause, ...errors], "publication and temporary cleanup failed", {
        cause,
      });
    throw cause;
  }
}
