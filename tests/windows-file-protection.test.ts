import { describe, expect, it } from "vitest";

import {
  prepareWindowsPrivateDestination,
  type WindowsProtectionOperations,
} from "../src/security/windows-file-protection.js";
import { windowsPowerShellCommand } from "../src/security/windows-file-protection-native.js";

const directory = "C:\\vault";
const destination = `${directory}\\secret.json`;
const stage = `${directory}\\secret.tmp`;

function fixture() {
  let nextId = 1;
  const entries = new Map<
    string,
    { kind: "file" | "directory" | "link"; identity: string; size: bigint }
  >();
  const protectedPaths = new Set<string>();
  const events: string[] = [];
  const add = (path: string, kind: "file" | "directory" | "link", size = 0n) => {
    entries.set(path, { kind, identity: String(nextId++), size });
  };
  const operations: WindowsProtectionOperations = {
    platform: "win32",
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
    protect: (path) => {
      events.push(`protect:${path}`);
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
  return { operations, entries, protectedPaths, events, add };
}

describe("windows private destination", () => {
  it("uses the native PowerShell binary and a matching child-only module path", () => {
    const environment = Object.freeze({
      SystemRoot: "C:\\Windows",
      PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
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
    expect(environment.PSModulePath).toBe("C:\\Program Files\\PowerShell\\7\\Modules");
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
    expect(state.events).toEqual(["volume"]);
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
