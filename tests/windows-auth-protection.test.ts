import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { atomicWrite0600, type AtomicWriteOperations } from "../src/auth/json-file.js";
import { acquireFileLease, type LeaseProtectionOperations } from "../src/auth/lease.js";
import type { WindowsFileProtection } from "../src/security/windows-file-protection.js";

const roots: string[] = [];
const root = (): string => {
  const path = mkdtempSync(join(tmpdir(), "lohra-win-auth-fake-"));
  roots.push(path);
  return path;
};

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeProtection(events: string[]) {
  const owned = new Set<string>();
  const prepare = (
    path: string,
    options?: { readonly exclusive?: boolean },
  ): WindowsFileProtection => {
    events.push(`prepare:${path}:${options?.exclusive === true ? "exclusive" : "existing"}`);
    if (options?.exclusive === true || !existsSync(path)) {
      closeSync(openSync(path, "wx", 0o600));
      owned.add(path);
    }
    const wasOwned = owned.has(path);
    return {
      verifyBeforeWrite: () => {
        events.push(`before-write:${path}`);
        if (!existsSync(path)) throw new Error("missing protected destination");
      },
      verifyBeforePublication: (source) => {
        events.push(`before-rename:${source}`);
        if (!existsSync(path) || !existsSync(source)) throw new Error("missing publication path");
      },
      verifyAfterPublication: () => {
        events.push(`after-rename:${path}`);
        if (!existsSync(path)) throw new Error("missing published path");
      },
      removeOwned: () => {
        events.push(`remove-owned:${path}`);
        if (!wasOwned) throw new Error("not owned");
        unlinkSync(path);
        owned.delete(path);
      },
    };
  };
  return prepare;
}

describe("Windows auth integration through fake protection ports", () => {
  it("protects the stage before bytes and checks both sides of atomic rename", () => {
    const home = root();
    const path = join(home, "oauth.json");
    const events: string[] = [];
    const prepare = fakeProtection(events);
    const operations: AtomicWriteOperations = {
      platform: "win32",
      prepare,
      mkdir: () => {
        throw new Error("Windows must not pre-create an unprotected directory");
      },
      open: (target, flags, mode) => {
        events.push(`open:${flags}`);
        return openSync(target, flags, mode);
      },
      write: (descriptor, bytes, offset) => {
        events.push("write");
        return writeSync(descriptor, bytes, offset);
      },
      fsync: () => events.push("fsync"),
      close: (descriptor) => {
        closeSync(descriptor);
      },
      rename: (source, destination) => {
        events.push("rename");
        const bytes = readFileSync(source);
        unlinkSync(source);
        // Fake cross-platform replacement for a Windows rename over an existing file.
        if (existsSync(destination)) unlinkSync(destination);
        const descriptor = openSync(destination, "wx", 0o600);
        writeSync(descriptor, bytes);
        closeSync(descriptor);
      },
      unlink: unlinkSync,
      pid: 1,
      now: () => 2,
    };
    atomicWrite0600(path, "old-fictional-token", operations);
    events.length = 0;
    atomicWrite0600(path, "new-fictional-token", operations);
    expect(readFileSync(path, "utf8")).toBe("new-fictional-token");
    expect(events).toEqual([
      `prepare:${path}:existing`,
      `prepare:${path}.tmp-1-2:exclusive`,
      `before-write:${path}.tmp-1-2`,
      "open:r+",
      "write",
      "fsync",
      `before-rename:${path}.tmp-1-2`,
      "rename",
      `after-rename:${path}`,
    ]);
  });

  it("preserves the prior login and reports cleanup failure with the protection cause", () => {
    const home = root();
    const path = join(home, "auth.json");
    const stage = `${path}.tmp-1-2`;
    const events: string[] = [];
    const prepare = fakeProtection(events);
    const descriptor = openSync(path, "wx", 0o600);
    writeSync(descriptor, "old-fictional-token");
    closeSync(descriptor);
    const operations: AtomicWriteOperations = {
      platform: "win32",
      prepare: (target, options) => {
        if (target === stage) {
          closeSync(openSync(stage, "wx", 0o600));
          throw new AggregateError(
            [new Error("ACL denied"), new Error("cleanup denied")],
            "protection and cleanup failed",
            { cause: new Error("ACL denied") },
          );
        }
        return prepare(target, options);
      },
      mkdir: () => {},
      open: openSync,
      write: (descriptor, bytes, offset) => writeSync(descriptor, bytes, offset),
      fsync: () => {},
      close: closeSync,
      rename: () => {
        throw new Error("must not publish");
      },
      unlink: unlinkSync,
      pid: 1,
      now: () => 2,
    };
    expect(() => {
      atomicWrite0600(path, "new-fictional-token", operations);
    }).toThrow(/protection and cleanup failed/);
    expect(readFileSync(path, "utf8")).toBe("old-fictional-token");
    expect(events).toEqual([`prepare:${path}:existing`]);
  });

  it("acquires a protected lock exclusively and reports EEXIST as contention", () => {
    const home = root();
    const path = join(home, "oauth.json.lock");
    const events: string[] = [];
    const protection: LeaseProtectionOperations = {
      platform: "win32",
      prepare: fakeProtection(events),
    };
    expect(acquireFileLease(path, "holder-a", 10, 1_000, protection)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      holder: "holder-a",
      expiresAt: 1_010,
    });
    expect(events.slice(0, 2)).toEqual([`prepare:${path}:exclusive`, `before-write:${path}`]);
    expect(acquireFileLease(path, "holder-b", 10, 1_000, protection)).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("holder-a");
  });
});
