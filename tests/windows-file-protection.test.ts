import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  ensureWindowsPrivateDirectory,
  prepareWindowsPrivateDestination,
  type WindowsProtectionOperations,
} from "../src/security/windows-file-protection.js";
import {
  ACL_SCRIPT,
  assertAclBatch,
  encodeAclRequests,
  runWindowsAclBatch,
  WindowsUnsupportedVolumeError,
  windowsPowerShellCommand,
} from "../src/security/windows-file-protection-native.js";

const directory = "C:\\vault";
const destination = `${directory}\\secret.json`;
const stage = `${directory}\\secret.tmp`;

type Kind = "file" | "directory" | "link";

/**
 * `native: true` models the real backend: `protect` applies the ACL and verifies
 * it by itself, and a group of requests (`batch`) costs one round trip. `trips`
 * lists the round trips, so a test can pin how many processes a sequence costs.
 */
function fixture(options: { readonly native?: boolean } = {}) {
  let nextId = 1;
  const entries = new Map<string, { kind: Kind; identity: string; size: bigint }>();
  const protectedPaths = new Set<string>();
  const descriptors = new Map<number, string>();
  let nextDescriptor = 100;
  const events: string[] = [];
  const trips: string[] = [];
  const add = (path: string, kind: Kind, size = 0n) => {
    entries.set(path, { kind, identity: String(nextId++), size });
  };
  const operations: WindowsProtectionOperations = {
    platform: "win32",
    ...(options.native
      ? {
          protectVerifies: true,
          batch: (
            requests: readonly { action: "volume" | "protect" | "verify"; path: string }[],
          ) => {
            trips.push(
              `batch:${requests.map(({ action, path }) => `${action}:${path}`).join(",")}`,
            );
            for (const { action, path } of requests) operations[action](path);
          },
        }
      : {}),
    volume: () => events.push("volume"),
    inspect: (path) => entries.get(path) ?? null,
    mkdir: (path) => {
      events.push(`mkdir:${path}`);
      add(path, "directory");
    },
    createEmpty: (path) => {
      events.push(`create:${path}`);
      add(path, "file");
    },
    openWrite: (path) => {
      events.push(`open:${path}`);
      const identity = entries.get(path)?.identity;
      if (!identity) throw new Error("missing fake file");
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, identity);
      return descriptor;
    },
    descriptorIdentity: (descriptor) => {
      events.push(`fstat:${String(descriptor)}`);
      const identity = descriptors.get(descriptor);
      if (!identity) throw new Error("missing fake descriptor");
      return identity;
    },
    close: (descriptor) => {
      events.push(`close:${String(descriptor)}`);
      descriptors.delete(descriptor);
    },
    protect: (path) => {
      events.push(`protect:${path}`);
      if (options.native) trips.push(`protect:${path}`);
      protectedPaths.add(path);
    },
    verify: (path) => {
      events.push(`verify:${path}`);
      if (!protectedPaths.has(path)) throw new Error(`incompatible ACL: ${path}`);
    },
    removeFile: (path) => {
      events.push(`unlink:${path}`);
      entries.delete(path);
    },
    removeDirectory: (path) => {
      events.push(`rmdir:${path}`);
      entries.delete(path);
    },
  };
  return { operations, entries, protectedPaths, events, trips, add };
}

describe("windows ACL batch contract", () => {
  it("rejects empty, oversized and protect-mixed ACL batches before launching a backend", () => {
    expect(() => {
      runWindowsAclBatch([]);
    }).toThrow(/one to three/);
    expect(() => {
      runWindowsAclBatch(Array.from({ length: 4 }, () => ({ action: "verify", path: directory })));
    }).toThrow(/one to three/);
    expect(() => {
      runWindowsAclBatch([
        { action: "protect", path: directory },
        { action: "verify", path: destination },
      ]);
    }).toThrow(/one to three/);
  });

  it("lets a volume check lead verifications, and nothing else share a batch", () => {
    const volume = { action: "volume", path: destination } as const;
    const verify = { action: "verify", path: directory } as const;
    const protect = { action: "protect", path: directory } as const;
    expect(() => {
      assertAclBatch([volume, verify, verify]);
    }).not.toThrow();
    expect(() => {
      assertAclBatch([protect]);
    }).not.toThrow();
    expect(() => {
      assertAclBatch([verify, volume]);
    }).toThrow(/one to three/);
    expect(() => {
      assertAclBatch([volume, protect]);
    }).toThrow(/one to three/);
    expect(() => {
      assertAclBatch([volume, volume]);
    }).toThrow(/one to three/);
    expect(() => {
      assertAclBatch([{ action: "verify touch", path: directory } as never]);
    }).toThrow(/one to three/);
  });

  it("carries every path as base64 UTF-8 data, never as script text", () => {
    const hostile = "C:\\vault\\ação\nprotect C:\\victim";
    const payload = encodeAclRequests([
      { action: "verify", path: hostile },
      { action: "volume", path: "D:\\x" },
    ]);
    const lines = payload.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((line) => line.split(" "));
    expect(first?.[0]).toBe("verify");
    expect(first?.[1]).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(first?.[1] ?? "", "base64").toString("utf8")).toBe(hostile);
    expect(second?.[0]).toBe("volume");
    expect(Buffer.from(second?.[1] ?? "", "base64").toString("utf8")).toBe("D:\\x");
  });

  it("reads ACLs through .NET and silences progress records, so stderr never carries CLIXML", () => {
    for (const cmdlet of ["Get-Acl", "Get-Item", "New-Object", "ConvertFrom-Json"]) {
      expect(ACL_SCRIPT).not.toContain(cmdlet);
    }
    expect(ACL_SCRIPT).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(ACL_SCRIPT).toContain("[System.IO.File]::GetAttributes");
    expect(ACL_SCRIPT).toContain("GetAccessControl");
  });
});

describe("windows private destination", () => {
  it("verifies a publication group only after inspecting all identities and reinspects all afterwards", () => {
    const state = fixture();
    const destinationGuard = prepareWindowsPrivateDestination(destination, state.operations);
    prepareWindowsPrivateDestination(stage, state.operations, { exclusive: true });
    const events: string[] = [];
    const inspect = (path: string) => state.entries.get(path) ?? null;
    Object.assign(state.operations, {
      inspect: (path: string) => {
        events.push(`inspect:${path}`);
        return inspect(path);
      },
      verifyMany: (paths: readonly string[]) => {
        events.push(`verifyMany:${paths.join(",")}`);
        expect(paths).toEqual([directory, destination, stage]);
      },
    });
    destinationGuard.verifyBeforePublication(stage);
    const batch = events.indexOf(`verifyMany:${directory},${destination},${stage}`);
    expect(batch).toBeGreaterThan(0);
    for (const path of [directory, destination, stage]) {
      expect(events.indexOf(`inspect:${path}`)).toBeLessThan(batch);
      expect(events.lastIndexOf(`inspect:${path}`)).toBeGreaterThan(batch);
    }
  });
  it("acquires a new protected file exclusively and removes only its own identity", () => {
    const state = fixture();
    const guard = prepareWindowsPrivateDestination(destination, state.operations, {
      exclusive: true,
    });
    guard.verifyBeforeWrite();
    expect(state.events.indexOf(`protect:${destination}`)).toBeLessThan(
      state.events.lastIndexOf(`verify:${destination}`),
    );
    guard.removeOwned();
    expect(state.entries.has(destination)).toBe(false);
  });

  it("opens only the verified file identity and closes a mismatched descriptor", () => {
    const state = fixture();
    const guard = prepareWindowsPrivateDestination(destination, state.operations, {
      exclusive: true,
    });
    state.operations.descriptorIdentity = () => "different-file";
    expect(() => guard.openOwnedForWrite()).toThrow(/open file identity changed/);
    expect(state.events).toContain(`close:100`);
  });

  it("reports both identity mismatch and failed descriptor close", () => {
    const state = fixture();
    const guard = prepareWindowsPrivateDestination(destination, state.operations, {
      exclusive: true,
    });
    state.operations.descriptorIdentity = () => "different-file";
    state.operations.close = () => {
      throw new Error("descriptor close denied");
    };
    try {
      guard.openOwnedForWrite();
      throw new Error("expected open failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        expect.stringContaining("open file identity changed"),
        "Error: descriptor close denied",
      ]);
    }
  });

  it("reports EEXIST for an existing exclusive destination before its ACL is ready", () => {
    const state = fixture();
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.add(destination, "file", 5n);
    expect(() =>
      prepareWindowsPrivateDestination(destination, state.operations, { exclusive: true }),
    ).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(state.entries.get(destination)?.size).toBe(5n);
    expect(state.events).not.toContain(`verify:${destination}`);
    expect(state.events).not.toContain(`protect:${destination}`);
    expect(state.events).not.toContain(`unlink:${destination}`);
  });

  it("requires an existing lock without creating an empty replacement", () => {
    const state = fixture();
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    expect(() =>
      prepareWindowsPrivateDestination(destination, state.operations, { existing: true }),
    ).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(state.entries.has(destination)).toBe(false);
  });

  it("never creates a directory while verifying an absent existing lock", () => {
    const state = fixture();
    expect(() =>
      prepareWindowsPrivateDestination(destination, state.operations, { existing: true }),
    ).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(state.events).toEqual(["volume"]);
    expect(state.entries.size).toBe(0);
  });

  it("keeps EEXIST when another process wins the exclusive create race", () => {
    const state = fixture();
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.operations.createEmpty = (path) => {
      state.add(path, "file");
      throw Object.assign(new Error("already created by contender"), { code: "EEXIST" });
    };
    expect(() =>
      prepareWindowsPrivateDestination(destination, state.operations, { exclusive: true }),
    ).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(state.entries.has(destination)).toBe(true);
    expect(state.events).not.toContain(`verify:${destination}`);
    expect(state.events).not.toContain(`protect:${destination}`);
    expect(state.events).not.toContain(`unlink:${destination}`);
  });

  it("refuses to remove a replaced file or a preexisting destination", () => {
    const state = fixture();
    const guard = prepareWindowsPrivateDestination(destination, state.operations, {
      exclusive: true,
    });
    state.add(destination, "file");
    expect(() => {
      guard.removeOwned();
    }).toThrow(/identity changed/);
    expect(state.entries.has(destination)).toBe(true);
    state.protectedPaths.add(destination);
    const existing = prepareWindowsPrivateDestination(destination, state.operations);
    expect(() => {
      existing.removeOwned();
    }).toThrow(/not owned/);
  });

  it("uses the native PowerShell binary and a matching child-only module path", () => {
    const environment = Object.freeze({
      SystemRoot: "C:\\Windows",
      PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
      PSMODULEPATH: "C:\\other-incompatible-modules",
      CUSTOM_MARKER: "retained",
    });
    const command = windowsPowerShellCommand(environment);
    expect(command.executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(command.environment.PSModulePath).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
    );
    expect(command.environment.CUSTOM_MARKER).toBe("retained");
    expect(
      Object.keys(command.environment).filter((name) => name.toLowerCase() === "psmodulepath"),
    ).toEqual(["PSModulePath"]);
    expect(environment.PSModulePath).toBe("C:\\Program Files\\PowerShell\\7\\Modules");
  });

  it("fails closed when the native PowerShell root is unavailable", () => {
    expect(() => windowsPowerShellCommand({ PSModulePath: "C:\\PowerShell\\7" })).toThrow(
      /SystemRoot/,
    );
  });

  it("rejects a relative path before creating a destination", () => {
    expect(() => prepareWindowsPrivateDestination("relative/private.json")).toThrow(/absolute/i);
  });

  it.each([
    "C:\\vault\\..\\secret",
    "C:\\vault\\secret:stream",
    "\\\\server\\share\\secret",
    "C:\\vault\\CON",
  ])("rejects ambiguous path %s", (path) => {
    const state = fixture();
    expect(() => prepareWindowsPrivateDestination(path, state.operations)).toThrow();
    expect(state.events).toEqual([]);
  });

  it("accepts Unicode path components without rewriting the path", () => {
    const state = fixture();
    const unicodeDirectory = "C:\\café";
    const unicodeFile = `${unicodeDirectory}\\privado-ç.json`;
    prepareWindowsPrivateDestination(unicodeFile, state.operations);
    expect(state.events).toContain(`protect:${unicodeDirectory}`);
    expect(state.events).toContain(`protect:${unicodeFile}`);
  });

  it("protects and verifies a new directory before creating the empty file", () => {
    const state = fixture();
    const guard = prepareWindowsPrivateDestination(destination, state.operations);
    guard.verifyBeforeWrite();
    expect(state.events).toEqual([
      "volume",
      `mkdir:${directory}`,
      `protect:${directory}`,
      `verify:${directory}`,
      `create:${destination}`,
      `protect:${destination}`,
      `verify:${destination}`,
      `verify:${directory}`,
      `verify:${destination}`,
    ]);
  });

  it("refuses an incompatible existing directory without modifying it", () => {
    const state = fixture();
    state.add(directory, "directory");
    expect(() => prepareWindowsPrivateDestination(destination, state.operations)).toThrow(
      /incompatible ACL/,
    );
    expect(state.events).toEqual(["volume", `verify:${directory}`]);
    expect(state.entries.has(destination)).toBe(false);
  });

  it("refuses an incompatible existing destination and preserves its contents", () => {
    const state = fixture();
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.add(destination, "file", 7n);
    expect(() => prepareWindowsPrivateDestination(destination, state.operations)).toThrow(
      /incompatible ACL/,
    );
    expect(state.entries.get(destination)?.size).toBe(7n);
    expect(state.events).not.toContain(`protect:${destination}`);
  });

  it("preserves a compatible existing destination until verified atomic replacement", () => {
    const state = fixture();
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.add(destination, "file", 7n);
    state.protectedPaths.add(destination);
    const guard = prepareWindowsPrivateDestination(destination, state.operations);
    expect(state.entries.get(destination)?.size).toBe(7n);
    expect(state.events).not.toContain(`create:${destination}`);
    expect(state.events).not.toContain(`protect:${destination}`);
    expect(() => {
      guard.verifyBeforeWrite();
    }).toThrow(/empty/);
    state.add(stage, "file", 9n);
    state.protectedPaths.add(stage);
    guard.verifyBeforePublication(stage);
    const stagedEntry = state.entries.get(stage);
    if (!stagedEntry) throw new Error("missing test stage");
    state.entries.set(destination, stagedEntry);
    state.entries.delete(stage);
    guard.verifyAfterPublication();
    expect(state.entries.get(destination)?.size).toBe(9n);
  });

  it("refuses a link in the path before ACL changes", () => {
    const state = fixture();
    state.add(directory, "link");
    expect(() => prepareWindowsPrivateDestination(destination, state.operations)).toThrow(
      /reparse/,
    );
    // The link is found by inspection alone: no backend process opens for it.
    expect(state.events).toEqual([]);
  });

  it("refuses an unsupported volume before creating anything", () => {
    const state = fixture();
    state.operations.volume = () => {
      throw new Error("fixed NTFS volume required");
    };
    expect(() => prepareWindowsPrivateDestination(destination, state.operations)).toThrow(/NTFS/);
    expect(state.events).toEqual([]);
  });

  it("cleans its empty file on ACL failure and preserves the cause", () => {
    const state = fixture();
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.operations.protect = () => {
      throw new Error("ACL mechanism unavailable");
    };
    expect(() => prepareWindowsPrivateDestination(destination, state.operations)).toThrow(
      "ACL mechanism unavailable",
    );
    expect(state.entries.has(destination)).toBe(false);
    expect(state.events).toContain(`unlink:${destination}`);
  });

  it.each([
    { path: directory, kind: "directory" },
    { path: destination, kind: "file" },
  ] as const)("reports an unverified created $kind without deleting it", ({ path, kind }) => {
    const state = fixture();
    if (kind === "file") {
      state.add(directory, "directory");
      state.protectedPaths.add(directory);
    }
    const inspect = state.operations.inspect.bind(state.operations);
    state.operations.inspect = (candidate) => {
      if (candidate === path && state.entries.has(path)) throw new Error("inspection denied");
      return inspect(candidate);
    };
    try {
      prepareWindowsPrivateDestination(destination, state.operations);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.cause).toEqual(new Error("inspection denied"));
      expect(aggregate.errors.map(String)).toEqual([
        "Error: inspection denied",
        expect.stringMatching(/cleanup inconclusive.*identity.*unverified/i),
      ]);
      expect(String(aggregate.errors[1])).toContain(path);
    }
    expect(state.entries.has(path)).toBe(true);
    expect(state.events).not.toContain(`unlink:${path}`);
    expect(state.events).not.toContain(`rmdir:${path}`);
  });

  it("retains its verified directory when a new child's identity is unavailable", () => {
    const state = fixture();
    const inspect = state.operations.inspect.bind(state.operations);
    state.operations.inspect = (path) => {
      if (path === destination && state.entries.has(path))
        throw new Error("file inspection denied");
      return inspect(path);
    };
    try {
      prepareWindowsPrivateDestination(destination, state.operations);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.cause).toEqual(new Error("file inspection denied"));
      expect(aggregate.errors.map(String)).toEqual([
        "Error: file inspection denied",
        expect.stringContaining(`retained ${destination}`),
        expect.stringContaining(`cleanup skipped for ${directory}`),
      ]);
    }
    expect(state.entries.has(destination)).toBe(true);
    expect(state.entries.has(directory)).toBe(true);
    expect(state.events).not.toContain(`unlink:${destination}`);
    expect(state.events).not.toContain(`rmdir:${directory}`);
  });

  it("reports a possible residual when empty file creation throws after creating it", () => {
    const state = fixture();
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.operations.createEmpty = (path) => {
      state.add(path, "file");
      throw new Error("close failed after create");
    };
    try {
      prepareWindowsPrivateDestination(destination, state.operations);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.cause).toEqual(new Error("close failed after create"));
      expect(aggregate.errors.map(String)).toEqual([
        "Error: close failed after create",
        expect.stringMatching(/cleanup inconclusive.*possible residual/i),
      ]);
      expect(String(aggregate.errors[1])).toContain(destination);
    }
    expect(state.entries.has(destination)).toBe(true);
    expect(state.events).not.toContain(`unlink:${destination}`);
  });

  it("removes its new directory after a file protection failure", () => {
    const state = fixture();
    state.operations.protect = (path) => {
      if (path === destination) throw new Error("file ACL failed");
      state.protectedPaths.add(path);
    };
    expect(() => prepareWindowsPrivateDestination(destination, state.operations)).toThrow(
      "file ACL failed",
    );
    expect(state.events.slice(-2)).toEqual([`unlink:${destination}`, `rmdir:${directory}`]);
    expect(state.entries.size).toBe(0);
  });

  it("reports cleanup failure alongside the primary ACL failure", () => {
    const state = fixture();
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.operations.protect = () => {
      throw new Error("ACL failed");
    };
    state.operations.removeFile = () => {
      throw new Error("cleanup failed");
    };
    try {
      prepareWindowsPrivateDestination(destination, state.operations);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        "Error: ACL failed",
        "Error: cleanup failed",
      ]);
    }
  });

  it("verifies stage and destination before and after publication", () => {
    const state = fixture();
    const guard = prepareWindowsPrivateDestination(destination, state.operations);
    state.add(stage, "file", 9n);
    state.protectedPaths.add(stage);
    guard.verifyBeforePublication(stage);
    const sourceEntry = state.entries.get(stage);
    if (!sourceEntry) throw new Error("missing test stage");
    state.entries.set(destination, sourceEntry);
    state.entries.delete(stage);
    guard.verifyAfterPublication();
    expect(state.events).toContain(`verify:${stage}`);
    expect(state.events.at(-1)).toBe(`verify:${destination}`);
  });

  it("rejects destination substitution across publication", () => {
    const state = fixture();
    const guard = prepareWindowsPrivateDestination(destination, state.operations);
    state.add(stage, "file", 9n);
    state.protectedPaths.add(stage);
    guard.verifyBeforePublication(stage);
    state.add(destination, "file", 9n);
    expect(() => {
      guard.verifyAfterPublication();
    }).toThrow(/identity changed/);
  });

  it("rejects a source still present after supposed publication", () => {
    const state = fixture();
    const guard = prepareWindowsPrivateDestination(destination, state.operations);
    state.add(stage, "file", 9n);
    state.protectedPaths.add(stage);
    guard.verifyBeforePublication(stage);
    const sourceEntry = state.entries.get(stage);
    if (!sourceEntry) throw new Error("missing test stage");
    state.entries.set(destination, sourceEntry);
    expect(() => {
      guard.verifyAfterPublication();
    }).toThrow(/still exists/);
  });

  it("rejects a modified empty destination before the first write", () => {
    const state = fixture();
    const guard = prepareWindowsPrivateDestination(destination, state.operations);
    const target = state.entries.get(destination);
    if (!target) throw new Error("missing test destination");
    target.size = 1n;
    expect(() => {
      guard.verifyBeforeWrite();
    }).toThrow(/no longer empty/);
  });
});

// Issue #942: the same checks, in fewer round trips. A "trip" is one backend
// process on Windows; the fixture counts the ones the real backend would open.
describe("windows private destination round trips", () => {
  it("creates a private directory and file in three trips: protect already verifies", () => {
    const state = fixture({ native: true });
    const guard = prepareWindowsPrivateDestination(destination, state.operations);
    expect(state.trips).toEqual([
      `batch:volume:${destination}`,
      `protect:${directory}`,
      `protect:${destination}`,
    ]);
    expect(state.events).not.toContain(`verify:${directory}`);
    expect(state.events).not.toContain(`verify:${destination}`);
    guard.verifyBeforeWrite();
    expect(state.trips.at(-1)).toBe(`batch:verify:${directory},verify:${destination}`);
  });

  it("checks the volume and an existing directory together, then creates and protects the file", () => {
    const state = fixture({ native: true });
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    prepareWindowsPrivateDestination(destination, state.operations);
    expect(state.trips).toEqual([
      `batch:volume:${destination},verify:${directory}`,
      `protect:${destination}`,
    ]);
    expect(state.events.indexOf(`verify:${directory}`)).toBeLessThan(
      state.events.indexOf(`create:${destination}`),
    );
  });

  it("checks the volume, the directory and an existing destination in one trip", () => {
    const state = fixture({ native: true });
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.add(destination, "file", 7n);
    state.protectedPaths.add(destination);
    prepareWindowsPrivateDestination(destination, state.operations);
    expect(state.trips).toEqual([
      `batch:volume:${destination},verify:${directory},verify:${destination}`,
    ]);
  });

  it("still refuses an exclusive create over an existing file without verifying that file", () => {
    const state = fixture({ native: true });
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.add(destination, "file", 5n);
    expect(() =>
      prepareWindowsPrivateDestination(destination, state.operations, { exclusive: true }),
    ).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(state.trips).toEqual([`batch:volume:${destination},verify:${directory}`]);
  });

  it("refuses a volume that rides with the first verification before anything is created", () => {
    const state = fixture({ native: true });
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.operations.volume = () => {
      throw new Error("fixed NTFS volume required");
    };
    expect(() => prepareWindowsPrivateDestination(destination, state.operations)).toThrow(/NTFS/);
    expect(state.events).toEqual([]);
    expect(state.entries.has(destination)).toBe(false);
  });

  it("refuses an incompatible existing destination in the same trip, preserving it", () => {
    const state = fixture({ native: true });
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.add(destination, "file", 7n);
    expect(() => prepareWindowsPrivateDestination(destination, state.operations)).toThrow(
      /incompatible ACL/,
    );
    expect(state.entries.get(destination)?.size).toBe(7n);
    expect(state.events).not.toContain(`protect:${destination}`);
  });

  it("keeps the identity check after a protect that already verified", () => {
    const state = fixture({ native: true });
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    const protect = state.operations.protect.bind(state.operations);
    state.operations.protect = (path) => {
      protect(path);
      // Another file takes the name right after the ACL was applied and verified.
      if (path === destination) state.add(path, "file");
    };
    try {
      prepareWindowsPrivateDestination(destination, state.operations);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(String((error as AggregateError).cause)).toMatch(/identity changed/);
    }
    expect(state.entries.has(destination)).toBe(true);
    expect(state.events).not.toContain(`unlink:${destination}`);
  });

  it("creates the Lohra home in two trips: volume, then a protect that already verifies", () => {
    const state = fixture({ native: true });
    ensureWindowsPrivateDirectory("C:\\lohra", state.operations);
    expect(state.trips).toEqual(["batch:volume:C:\\lohra", "protect:C:\\lohra"]);
    expect(state.events).not.toContain("verify:C:\\lohra");
  });

  it("keeps the identity check after the home's protect", () => {
    const state = fixture({ native: true });
    const protect = state.operations.protect.bind(state.operations);
    state.operations.protect = (path) => {
      protect(path);
      state.add(path, "directory");
    };
    expect(() => {
      ensureWindowsPrivateDirectory("C:\\lohra", state.operations);
    }).toThrow(/private Windows directory/);
    expect(state.entries.has("C:\\lohra")).toBe(true);
  });
});

// Real mechanism, throwaway folders under the OS temp dir (never a profile or
// home). Each case opens one to three PowerShell processes.
describe("windows ACL mechanism on real folders", () => {
  const windowsOnly = it.runIf(process.platform === "win32");
  const roots: string[] = [];
  afterAll(() => {
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  const throwaway = (): string => {
    const path = mkdtempSync(join(tmpdir(), "lohra-acl-cost-"));
    roots.push(path);
    return path;
  };
  const failureOf = (run: () => void): Error => {
    try {
      run();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the ACL mechanism to refuse");
  };

  windowsOnly(
    "refuses a folder that only inherits its rules, names the failing request, no CLIXML",
    () => {
      const folder = throwaway();
      const failure = failureOf(() => {
        runWindowsAclBatch([
          { action: "volume", path: join(folder, "auth.json") },
          { action: "verify", path: folder },
        ]);
      });
      expect(failure.message).toContain(
        `Windows ACL verify failed at ${folder}: Inherited access rules remain enabled`,
      );
      expect(failure.message).not.toMatch(/CLIXML|<Objs/);
    },
  );

  windowsOnly("refuses a reparse point with the same cause on verify and protect", () => {
    const root = throwaway();
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target);
    symlinkSync(target, link, "junction");
    for (const action of ["verify", "protect"] as const) {
      const failure = failureOf(() => {
        runWindowsAclBatch([{ action, path: link }]);
      });
      expect(failure.message).toContain(
        `Windows ACL ${action} failed at ${link}: Windows reparse point is not verifiable`,
      );
      expect(failure.message).not.toMatch(/CLIXML|<Objs/);
    }
  });

  windowsOnly(
    "refuses a volume that is not a fixed NTFS one with the unsupported-volume error",
    () => {
      const unused = ["Z", "Y", "X", "W", "V", "U", "T", "S", "R", "Q", "P"].find(
        (letter) => !existsSync(`${letter}:\\`),
      );
      if (!unused) return;
      const failure = failureOf(() => {
        runWindowsAclBatch([{ action: "volume", path: `${unused}:\\auth.json` }]);
      });
      expect(failure).toBeInstanceOf(WindowsUnsupportedVolumeError);
      expect(failure.message).toContain("Private destinations require a fixed NTFS volume");
      expect(failure.message).not.toMatch(/CLIXML|<Objs/);
    },
  );

  windowsOnly(
    "protects a folder and a file, then verifies volume, folder and file together",
    () => {
      const folder = throwaway();
      const file = join(folder, "auth.json");
      runWindowsAclBatch([{ action: "protect", path: folder }]);
      closeSync(openSync(file, "wx"));
      runWindowsAclBatch([{ action: "protect", path: file }]);
      runWindowsAclBatch([
        { action: "volume", path: file },
        { action: "verify", path: folder },
        { action: "verify", path: file },
      ]);
    },
  );
});
