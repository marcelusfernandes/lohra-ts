import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { atomicWritePrivate0600, type AtomicWriteOperations } from "../src/auth/json-file.js";
import { acquireFileLease, type LeaseProtectionOperations } from "../src/auth/lease.js";
import { refreshUnderLease } from "../src/auth/credentials.js";
import { OAuthTokens } from "../src/auth/types.js";
import {
  prepareWindowsPrivateDestination,
  type WindowsFileProtection,
  type WindowsProtectionOperations,
} from "../src/security/windows-file-protection.js";

const injectedWrite = vi.hoisted(() => ({ armed: false }));
vi.mock("../src/auth/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/store.js")>();
  return {
    ...actual,
    writeTokens: (...args: Parameters<typeof actual.writeTokens>) => {
      if (injectedWrite.armed) throw new Error("injected EACCES");
      actual.writeTokens(...args);
    },
  };
});

const roots: string[] = [];
const root = (): string => {
  const path = mkdtempSync(join(tmpdir(), "lohra-win-auth-fake-"));
  roots.push(path);
  return path;
};

afterEach(() => {
  injectedWrite.armed = false;
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeProtection(events: string[]) {
  const owned = new Set<string>();
  const prepare = (
    path: string,
    options?: { readonly exclusive?: boolean; readonly existing?: boolean },
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
      openOwnedForWrite: () => {
        events.push(`before-write:${path}`);
        if (!existsSync(path)) throw new Error("missing protected destination");
        events.push("open:r+");
        return openSync(path, "r+");
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

// Issue #942: the credential write keeps every identity and ACL check of the
// sequence while it opens fewer backend processes. The real protection module
// runs over an in-memory backend that, like the real one, applies and verifies
// in `protect` and groups requests into one trip (one process) per `batch`.
describe("Windows credential write, check by check", () => {
  const vault = "C:\\vault";
  const target = `${vault}\\auth.json`;
  const staged = `${target}.tmp-1-2`;

  function memoryWrite(existing: boolean) {
    let nextId = 1;
    const entries = new Map<
      string,
      { kind: "file" | "directory"; identity: string; size: bigint }
    >();
    const protectedPaths = new Set<string>();
    const descriptors = new Map<number, string>();
    const timeline: string[] = [];
    const log: string[] = [];
    let trips = 0;
    const add = (path: string, kind: "file" | "directory") => {
      entries.set(path, { kind, identity: String(nextId++), size: 0n });
    };
    if (existing) {
      add(vault, "directory");
      add(target, "file");
      protectedPaths.add(vault).add(target);
    }
    const trip = (requests: readonly string[]) => {
      trips += 1;
      timeline.push(`trip ${requests.join(" + ")}`);
      log.push(`trip:${String(trips)}`);
    };
    const mutate = (entry: string) => {
      timeline.push(entry);
      log.push(entry);
    };
    const operations: WindowsProtectionOperations = {
      platform: "win32",
      protectVerifies: true,
      volume: () => {},
      inspect: (path) => {
        log.push(`inspect:${path}`);
        return entries.get(path) ?? null;
      },
      mkdir: (path) => {
        mutate(`mkdir ${path}`);
        add(path, "directory");
      },
      createEmpty: (path) => {
        mutate(`create ${path}`);
        add(path, "file");
      },
      openWrite: (path) => {
        const descriptor = 100 + descriptors.size;
        descriptors.set(descriptor, entries.get(path)?.identity ?? "missing");
        return descriptor;
      },
      descriptorIdentity: (descriptor) => descriptors.get(descriptor) ?? "missing",
      close: () => {},
      protect: (path) => {
        trip([`protect ${path}`]);
        protectedPaths.add(path);
      },
      verify: () => {
        throw new Error("every verification goes through a batch");
      },
      batch: (requests) => {
        trip(requests.map(({ action, path }) => `${action} ${path}`));
        for (const { action, path } of requests) {
          if (action === "verify" && !protectedPaths.has(path)) {
            throw new Error(`incompatible ACL: ${path}`);
          }
        }
      },
      removeFile: (path) => {
        entries.delete(path);
      },
      removeDirectory: (path) => {
        entries.delete(path);
      },
    };
    const write: AtomicWriteOperations = {
      platform: "win32",
      prepare: (path, options) => prepareWindowsPrivateDestination(path, operations, options),
      mkdir: () => {
        throw new Error("Windows must not pre-create an unprotected directory");
      },
      open: () => {
        throw new Error("the protection module opens the stage");
      },
      write: (_descriptor, bytes, offset) => {
        mutate("write");
        return bytes.length - offset;
      },
      fsync: () => {},
      close: () => {},
      rename: (source, destination) => {
        mutate("rename");
        const moved = entries.get(source);
        if (!moved) throw new Error("missing staged file");
        entries.set(destination, moved);
        entries.delete(source);
      },
      unlink: () => {},
      pid: 1,
      now: () => 2,
    };
    return { write, timeline, log, entries, protectedPaths };
  }

  // Every identity a trip verifies or protects is observed after the last change
  // before it and again right after it, before the next change.
  function expectIdentityAroundEveryTrip(log: readonly string[], timeline: readonly string[]) {
    const segments: string[][] = [[]];
    for (const entry of log) {
      if (entry.startsWith("trip:")) segments.push([]);
      else segments[segments.length - 1]?.push(entry);
    }
    const isChange = (entry: string) => /^(mkdir|create|write|rename)/.test(entry);
    const trips = timeline.filter((entry) => entry.startsWith("trip "));
    trips.forEach((entry, index) => {
      for (const request of entry.slice("trip ".length).split(" + ")) {
        const [action, path] = [
          request.slice(0, request.indexOf(" ")),
          request.slice(request.indexOf(" ") + 1),
        ];
        if (action === "volume") continue;
        const before = segments[index] ?? [];
        const after = segments[index + 1] ?? [];
        const lastChange = before.map(isChange).lastIndexOf(true);
        expect(
          before.lastIndexOf(`inspect:${path}`),
          `before trip ${String(index + 1)}: ${request}`,
        ).toBeGreaterThan(lastChange);
        const firstChange = after.findIndex(isChange);
        const firstInspect = after.indexOf(`inspect:${path}`);
        expect(firstInspect, `after trip ${String(index + 1)}: ${request}`).toBeGreaterThanOrEqual(
          0,
        );
        if (firstChange >= 0) expect(firstInspect).toBeLessThan(firstChange);
      }
    });
  }

  it("creates a private home and credential in eight trips, none of its checks dropped", () => {
    const state = memoryWrite(false);
    atomicWritePrivate0600(target, "fictional-token", state.write);
    expect(state.timeline).toEqual([
      `trip volume ${target}`,
      `mkdir ${vault}`,
      `trip protect ${vault}`,
      `create ${target}`,
      `trip protect ${target}`,
      `trip volume ${staged} + verify ${vault}`,
      `create ${staged}`,
      `trip protect ${staged}`,
      `trip verify ${vault} + verify ${staged}`,
      "write",
      `trip verify ${vault} + verify ${target} + verify ${staged}`,
      "rename",
      `trip verify ${vault} + verify ${target}`,
    ]);
    expectIdentityAroundEveryTrip(state.log, state.timeline);
    expect(state.entries.has(staged)).toBe(false);
  });

  it("renews an existing credential in six trips, none of its checks dropped", () => {
    const state = memoryWrite(true);
    atomicWritePrivate0600(target, "fictional-token", state.write);
    expect(state.timeline).toEqual([
      `trip volume ${target} + verify ${vault} + verify ${target}`,
      `trip volume ${staged} + verify ${vault}`,
      `create ${staged}`,
      `trip protect ${staged}`,
      `trip verify ${vault} + verify ${staged}`,
      "write",
      `trip verify ${vault} + verify ${target} + verify ${staged}`,
      "rename",
      `trip verify ${vault} + verify ${target}`,
    ]);
    expectIdentityAroundEveryTrip(state.log, state.timeline);
  });

  it("refuses a directory whose rules are not verified before creating anything in it", () => {
    const state = memoryWrite(true);
    state.protectedPaths.delete(vault);
    let caught: unknown;
    try {
      atomicWritePrivate0600(target, "fictional-token", state.write);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("check that the destination");
    expect(String((caught as Error).cause)).toContain(`incompatible ACL: ${vault}`);
    expect(state.timeline.some((entry) => entry.startsWith("create "))).toBe(false);
    expect(state.timeline).toEqual([`trip volume ${target} + verify ${vault} + verify ${target}`]);
  });
});

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
    atomicWritePrivate0600(path, "old-fictional-token", operations);
    events.length = 0;
    atomicWritePrivate0600(path, "new-fictional-token", operations);
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
    let caught: unknown;
    try {
      atomicWritePrivate0600(path, "new-fictional-token", operations);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("check that the destination");
    expect((caught as Error).cause).toBeInstanceOf(AggregateError);
    expect(((caught as Error).cause as AggregateError).errors.map(String)).toEqual([
      "Error: ACL denied",
      "Error: cleanup denied",
    ]);
    expect(readFileSync(path, "utf8")).toBe("old-fictional-token");
    expect(events).toEqual([`prepare:${path}:existing`]);
  });

  it("reports stage cleanup failure without replacing valid credentials", () => {
    const home = root();
    const path = join(home, "oauth.json");
    writeFileSync(path, "old-fictional-token");
    const prepare = fakeProtection([]);
    const operations: AtomicWriteOperations = {
      platform: "win32",
      prepare: (target, options) => {
        const guard = prepare(target, options);
        if (options?.exclusive !== true) return guard;
        return {
          ...guard,
          openOwnedForWrite: () => {
            throw new Error("stage ACL revoked");
          },
          removeOwned: () => {
            throw new Error("stage cleanup denied");
          },
        };
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
    let caught: unknown;
    try {
      atomicWritePrivate0600(path, "new-fictional-token", operations);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).cause).toBeInstanceOf(AggregateError);
    expect(((caught as Error).cause as AggregateError).errors.map(String)).toEqual([
      "Error: stage ACL revoked",
      "Error: stage cleanup denied",
    ]);
    expect(readFileSync(path, "utf8")).toBe("old-fictional-token");
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

  it("treats a just-created empty lock as busy while its ACL is incomplete", () => {
    const home = root();
    const path = join(home, "oauth.json.lock");
    writeFileSync(path, "");
    const events: string[] = [];
    const protection: LeaseProtectionOperations = {
      platform: "win32",
      prepare: fakeProtection(events),
    };
    expect(acquireFileLease(path, "contender", 10, Date.now() / 1000, protection)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(events).toEqual([`prepare:${path}:exclusive`]);
  });

  it("keeps protection and cleanup causes when lock acquisition fails", async () => {
    const home = root();
    const primary = new Error("ACL denied");
    const protectionFailure = new AggregateError(
      [primary, new Error("cleanup denied")],
      "Windows protection and cleanup failed",
      { cause: primary },
    );
    const protection: LeaseProtectionOperations = {
      platform: "win32",
      prepare: () => {
        throw protectionFailure;
      },
    };
    const own = new OAuthTokens("old-fictional-token", "fictional-refresh", "account", 900);
    let caught: unknown;
    try {
      await refreshUnderLease(
        home,
        own,
        1_000,
        () => {
          throw new Error("refresh should not be called");
        },
        protection,
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe("TokenPersistError");
    expect((caught as Error).cause).toBe(protectionFailure);
    expect((caught as Error).message).not.toContain("old-fictional-token");
  });

  it("reports failed release after a successful reread without leaking the token", async () => {
    const home = root();
    writeFileSync(
      join(home, "oauth.json"),
      JSON.stringify({
        access_token: "fresh-fictional-token",
        refresh_token: "fictional-refresh",
        account_id: "fictional-account",
        expires_at: 10_000,
      }),
    );
    const events: string[] = [];
    const prepare = fakeProtection(events);
    const protection: LeaseProtectionOperations = {
      platform: "win32",
      prepare: (path, options) => {
        if (options?.existing === true) throw new Error("ACL verification denied");
        return prepare(path, options);
      },
    };
    const own = new OAuthTokens("old-fictional-token", "old-refresh", "account", 900);
    let caught: unknown;
    try {
      await refreshUnderLease(
        home,
        own,
        1_000,
        () => {
          throw new Error("refresh should not be called");
        },
        protection,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("TokenPersistError");
    expect((caught as Error).cause).toEqual(new Error("ACL verification denied"));
    expect((caught as Error).message).not.toContain("fresh-fictional-token");
  });

  it("retains the primary refresh fault alongside failed lock cleanup", async () => {
    const home = root();
    writeFileSync(
      join(home, "oauth.json"),
      JSON.stringify({
        access_token: "stale-fictional-token",
        refresh_token: "fictional-refresh",
        account_id: "fictional-account",
        expires_at: 900,
      }),
    );
    const prepare = fakeProtection([]);
    const protection: LeaseProtectionOperations = {
      platform: "win32",
      prepare: (path, options) => {
        if (options?.existing === true) throw new Error("cleanup denied");
        return prepare(path, options);
      },
    };
    const own = new OAuthTokens("stale-fictional-token", "fictional-refresh", "account", 900);
    let caught: unknown;
    try {
      await refreshUnderLease(
        home,
        own,
        1_000,
        () => Promise.reject(new Error("POST failed")),
        protection,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("RefreshFailedError");
    expect((caught as Error).message).toContain("could not refresh the login");
    expect((caught as Error).message).toContain("run `lohra auth login` again");
    expect((caught as Error).cause).toEqual(new Error("cleanup denied"));
    expect((caught as Error).message).not.toContain("stale-fictional-token");
  });

  it("keeps TokenPersistError and its guidance when saving and lock cleanup both fail", async () => {
    const home = root();
    writeFileSync(
      join(home, "oauth.json"),
      JSON.stringify({
        access_token: "stale-fictional-token",
        refresh_token: "fictional-refresh",
        account_id: "fictional-account",
        expires_at: 900,
      }),
    );
    const prepare = fakeProtection([]);
    const protection: LeaseProtectionOperations = {
      platform: "win32",
      prepare: (path, options) => {
        if (options?.existing === true) throw new Error("cleanup denied");
        return prepare(path, options);
      },
    };
    injectedWrite.armed = true;
    const own = new OAuthTokens("stale-fictional-token", "fictional-refresh", "account", 900);
    let caught: unknown;
    try {
      await refreshUnderLease(
        home,
        own,
        1_000,
        () =>
          Promise.resolve([
            200,
            {
              access_token: "fresh-fictional-token",
              refresh_token: "new-refresh",
              expires_in: 3600,
            },
          ]),
        protection,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("TokenPersistError");
    expect((caught as Error).message).toContain("check permissions/disk space");
    expect((caught as Error).message).toContain("run `lohra auth login` again");
    expect((caught as Error).cause).toBeInstanceOf(AggregateError);
    expect(((caught as Error).cause as AggregateError).errors.map(String)).toEqual([
      "Error: injected EACCES",
      "Error: cleanup denied",
    ]);
    expect((caught as Error).message).not.toContain("fresh-fictional-token");
  });
});
