// Issue #941 (épico #899, ADR 0006): o home e o diretório do profile que o
// próprio Lohra cria nascem protegidos no Windows, antes de qualquer
// credencial. Diretório que já existe nunca é tocado (a ADR manda recusar, não
// reparar). O núcleo é provado com operações injetadas, sem PowerShell real;
// a fiação (`openStateDatabase`, `ensureHome`) é provada trocando só a
// plataforma e observando a chamada à primitiva.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureHome, runProfile } from "../src/onboarding/profiles.js";
import {
  ensureWindowsPrivateDirectory,
  prepareWindowsPrivateDestination,
  type WindowsProtectionOperations,
} from "../src/security/windows-file-protection.js";
import {
  ACL_SCRIPT,
  aclBatchFailure,
  WindowsUnsupportedVolumeError,
} from "../src/security/windows-file-protection-native.js";
import { openStateDatabase } from "../src/state/connection.js";

vi.mock("../src/security/windows-file-protection.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/security/windows-file-protection.js")>();
  return { ...actual, ensureWindowsPrivateDirectory: vi.fn(actual.ensureWindowsPrivateDirectory) };
});

const base = "C:\\lohra";
const profiles = `${base}\\profiles`;
const profile = `${profiles}\\diag`;

type Kind = "file" | "directory" | "link";

function fixture(present: readonly string[] = []) {
  let nextId = 1;
  const entries = new Map<string, { kind: Kind; identity: string; size: bigint }>();
  const protectedPaths = new Set<string>();
  const events: string[] = [];
  const failures = {
    protect: new Map<string, Error>(),
    verify: new Map<string, Error>(),
    removeDirectory: new Map<string, Error>(),
    contender: new Set<string>(),
    mkdir: new Map<string, Error>(),
    volume: null as Error | null,
  };
  const add = (path: string, kind: Kind = "directory") => {
    entries.set(path, { kind, identity: String(nextId++), size: 0n });
  };
  for (const path of present) add(path);
  const operations: WindowsProtectionOperations = {
    platform: "win32",
    volume: () => {
      events.push("volume");
      if (failures.volume) throw failures.volume;
    },
    inspect: (path) => entries.get(path) ?? null,
    mkdir: (path) => {
      events.push(`mkdir:${path}`);
      const failure = failures.mkdir.get(path);
      if (failure) throw failure;
      add(path);
      if (failures.contender.has(path)) {
        throw Object.assign(new Error("created by contender"), { code: "EEXIST" });
      }
    },
    createEmpty: (path) => {
      events.push(`create:${path}`);
      add(path, "file");
    },
    openWrite: () => {
      throw new Error("unused");
    },
    descriptorIdentity: () => {
      throw new Error("unused");
    },
    close: () => {
      throw new Error("unused");
    },
    protect: (path) => {
      events.push(`protect:${path}`);
      const failure = failures.protect.get(path);
      if (failure) throw failure;
      protectedPaths.add(path);
    },
    verify: (path) => {
      events.push(`verify:${path}`);
      const failure = failures.verify.get(path);
      if (failure) throw failure;
      if (!protectedPaths.has(path)) throw new Error(`incompatible ACL: ${path}`);
    },
    removeFile: (path) => {
      events.push(`unlink:${path}`);
      entries.delete(path);
    },
    removeDirectory: (path) => {
      events.push(`rmdir:${path}`);
      const failure = failures.removeDirectory.get(path);
      if (failure) throw failure;
      entries.delete(path);
    },
  };
  return { operations, entries, protectedPaths, events, failures, add };
}

function createdWith(
  run: () => void,
): Error & { cause?: Error & { errors?: unknown[]; cause?: unknown } } {
  try {
    run();
  } catch (error) {
    return error as Error & { cause?: Error & { errors?: unknown[]; cause?: unknown } };
  }
  throw new Error("expected the private directory creation to fail");
}

describe("ensureWindowsPrivateDirectory", () => {
  it("creates an absent home, protects and verifies it, and only then lets a write proceed", () => {
    const state = fixture();
    ensureWindowsPrivateDirectory(base, state.operations);
    expect(state.events).toEqual(["volume", `mkdir:${base}`, `protect:${base}`, `verify:${base}`]);

    prepareWindowsPrivateDestination(`${base}\\auth.json`, state.operations);
    expect(state.events.indexOf(`verify:${base}`)).toBeLessThan(
      state.events.indexOf(`create:${base}\\auth.json`),
    );
    expect(state.events.filter((event) => event === `protect:${base}`)).toHaveLength(1);
  });

  it("never protects, verifies or alters a directory that already exists", () => {
    const state = fixture([base]);
    ensureWindowsPrivateDirectory(base, state.operations);
    expect(state.events).toEqual([]);
    expect(state.protectedPaths.size).toBe(0);

    // ADR 0006: the sensitive write is the one that refuses it, with a cause.
    expect(() => prepareWindowsPrivateDestination(`${base}\\auth.json`, state.operations)).toThrow(
      /incompatible ACL/,
    );
    expect(state.events).not.toContain(`protect:${base}`);
    expect(state.entries.has(`${base}\\auth.json`)).toBe(false);
  });

  it("leaves an existing link or file at the destination untouched", () => {
    for (const kind of ["link", "file"] as const) {
      const state = fixture();
      state.add(base, kind);
      ensureWindowsPrivateDirectory(base, state.operations);
      expect(state.events).toEqual([]);
    }
  });

  it("creates only the missing levels, each protected and verified before the next", () => {
    const state = fixture([base]);
    ensureWindowsPrivateDirectory(profile, state.operations);
    expect(state.events).toEqual([
      "volume",
      `mkdir:${profiles}`,
      `protect:${profiles}`,
      `verify:${profiles}`,
      `mkdir:${profile}`,
      `protect:${profile}`,
      `verify:${profile}`,
    ]);
    expect(state.protectedPaths.has(base)).toBe(false);

    prepareWindowsPrivateDestination(`${profile}\\auth.json`, state.operations);
    expect(state.entries.has(`${profile}\\auth.json`)).toBe(true);
  });

  it("protects the base that holds the .env when the whole chain is new", () => {
    const state = fixture();
    ensureWindowsPrivateDirectory(profile, state.operations);
    expect([...state.protectedPaths]).toEqual([base, profiles, profile]);
    expect(state.events.indexOf(`verify:${base}`)).toBeLessThan(
      state.events.indexOf(`mkdir:${profiles}`),
    );
    prepareWindowsPrivateDestination(`${base}\\.env`, state.operations);
    prepareWindowsPrivateDestination(`${profile}\\auth.json`, state.operations);
  });

  it("fails closed on protect failure, removes only what it created and keeps the cause", () => {
    const state = fixture([base]);
    const primary = new Error("protect denied");
    state.failures.protect.set(profile, primary);
    const error = createdWith(() => {
      ensureWindowsPrivateDirectory(profile, state.operations);
    });
    expect(error.message).toContain(profile);
    expect(error.cause).toBe(primary);
    expect(state.events.filter((event) => event.startsWith("rmdir:"))).toEqual([
      `rmdir:${profile}`,
      `rmdir:${profiles}`,
    ]);
    expect(state.entries.has(profile)).toBe(false);
    expect(state.entries.has(profiles)).toBe(false);
    expect(state.entries.has(base)).toBe(true);
    expect(state.events).not.toContain(`protect:${base}`);
    expect(state.events).not.toContain(`rmdir:${base}`);
  });

  it("fails closed on verify failure and never descends into an unverified level", () => {
    const state = fixture([base]);
    const primary = new Error("verify denied");
    state.failures.verify.set(profiles, primary);
    const error = createdWith(() => {
      ensureWindowsPrivateDirectory(profile, state.operations);
    });
    expect(error.cause).toBe(primary);
    expect(state.events).not.toContain(`mkdir:${profile}`);
    expect(state.events).toContain(`rmdir:${profiles}`);
    expect(state.entries.has(profiles)).toBe(false);
    expect(state.entries.has(base)).toBe(true);
  });

  it("reports a failed cleanup together with the primary cause", () => {
    const state = fixture([base]);
    const primary = new Error("protect denied");
    const cleanup = new Error("rmdir denied");
    state.failures.protect.set(profile, primary);
    state.failures.removeDirectory.set(profile, cleanup);
    const error = createdWith(() => {
      ensureWindowsPrivateDirectory(profile, state.operations);
    });
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause?.cause).toBe(primary);
    expect(error.cause?.errors).toEqual([primary, cleanup]);
    // The failed removal does not stop the cleanup of the ancestor it created.
    expect(state.entries.has(profiles)).toBe(false);
  });

  it("treats a concurrent creator as an existing directory: no protect, no removal", () => {
    const state = fixture([base]);
    state.failures.contender.add(profiles);
    ensureWindowsPrivateDirectory(profile, state.operations);
    expect(state.events).not.toContain(`protect:${profiles}`);
    expect(state.events).not.toContain(`rmdir:${profiles}`);
    expect(state.entries.has(profiles)).toBe(true);
    expect(state.protectedPaths.has(profile)).toBe(true);
  });

  it("refuses another platform before touching the disk", () => {
    const state = fixture();
    expect(() => {
      ensureWindowsPrivateDirectory(base, { ...state.operations, platform: "linux" });
    }).toThrow(/requires Windows/);
    expect(state.events).toEqual([]);
  });

  describe("a path or volume that cannot be protected", () => {
    const short = "C:\\RUNNER~1";
    const unc = "\\\\server\\share\\lohra";

    it.each([
      {
        label: "8.3",
        path: `${short}\\a\\lohra`,
        created: [short, `${short}\\a`],
        reason: /ambiguous/,
      },
      { label: "UNC", path: unc, created: [], reason: /absolute local drive path/ },
    ])(
      "creates a $label path unprotected, as before, and refuses credentials there",
      (scenario) => {
        const state = fixture();
        ensureWindowsPrivateDirectory(scenario.path, state.operations);
        expect(state.events).toEqual([...scenario.created, scenario.path].map((p) => `mkdir:${p}`));
        expect(state.protectedPaths.size).toBe(0);

        expect(() =>
          prepareWindowsPrivateDestination(`${scenario.path}\\auth.json`, state.operations),
        ).toThrow(scenario.reason);
        expect(state.entries.has(`${scenario.path}\\auth.json`)).toBe(false);
      },
    );

    it("creates the levels unprotected when the volume is not a fixed NTFS one", () => {
      const state = fixture();
      state.failures.volume = new WindowsUnsupportedVolumeError("not a fixed NTFS volume");
      ensureWindowsPrivateDirectory(profile, state.operations);
      expect(state.events).toEqual([
        "volume",
        ...[base, profiles, profile].map((p) => `mkdir:${p}`),
      ]);
      expect(state.protectedPaths.size).toBe(0);
    });

    it("keeps the mkdir failure and the concurrent creator semantics of a plain mkdir", () => {
      const denied = Object.assign(new Error("denied"), { code: "EACCES" });
      const refused = fixture();
      refused.failures.mkdir.set(short, denied);
      expect(() => {
        ensureWindowsPrivateDirectory(`${short}\\lohra`, refused.operations);
      }).toThrow(expect.objectContaining({ code: "EACCES" }));

      const raced = fixture();
      raced.failures.contender.add(short);
      ensureWindowsPrivateDirectory(`${short}\\lohra`, raced.operations);
      expect(raced.entries.has(`${short}\\lohra`)).toBe(true);
    });

    it("does not treat a volume check that failed for another reason as unprotectable", () => {
      const state = fixture();
      const primary = new Error("powershell unavailable");
      state.failures.volume = primary;
      const error = createdWith(() => {
        ensureWindowsPrivateDirectory(base, state.operations);
      });
      expect(error.message).toContain(base);
      expect(error.cause).toBe(primary);
      expect(state.events).toEqual(["volume"]);
    });

    it("still fails closed when protect fails on a supported volume", () => {
      const state = fixture();
      state.failures.protect.set(base, new Error("owner differs"));
      expect(() => {
        ensureWindowsPrivateDirectory(base, state.operations);
      }).toThrow(/private Windows directory/);
      expect(state.entries.has(base)).toBe(false);
    });
  });
});

describe("native ACL runner", () => {
  const request = [{ action: "volume", path: "D:\\x" }] as const;
  const refusal =
    "Windows ACL volume failed at D:\\x: Private destinations require a fixed NTFS volume";

  it("classifies only a refused volume as an unsupported one", () => {
    const unsupported = aclBatchFailure(request, 1, null, refusal);
    expect(unsupported).toBeInstanceOf(WindowsUnsupportedVolumeError);
    expect(unsupported.message).toBe(`Windows ACL batch failed (exit 1, signal null): ${refusal}`);

    const unrelated = aclBatchFailure(
      request,
      1,
      null,
      "Windows ACL volume failed at D:\\x: no drive",
    );
    expect(unrelated).not.toBeInstanceOf(WindowsUnsupportedVolumeError);
    const notVolume = aclBatchFailure([{ action: "protect", path: "D:\\x" }], 1, null, refusal);
    expect(notVolume).not.toBeInstanceOf(WindowsUnsupportedVolumeError);
    expect(aclBatchFailure(request, null, "SIGTERM", " ").message).toBe(
      "Windows ACL batch failed (exit null, signal SIGTERM): unverified result",
    );
  });

  it("makes the current user the owner before applying a protected DACL, only when it differs", () => {
    const protectBranch = ACL_SCRIPT.indexOf("$request.action -eq 'protect'");
    const setOwner = ACL_SCRIPT.indexOf("$acl.SetOwner($identity)");
    const setAcl = ACL_SCRIPT.indexOf("Set-Acl -LiteralPath $path -AclObject $acl");
    expect(protectBranch).toBeGreaterThan(-1);
    expect(setOwner).toBeGreaterThan(protectBranch);
    expect(setOwner).toBeLessThan(setAcl);
    expect(ACL_SCRIPT.slice(protectBranch, setOwner)).toMatch(
      /GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)\.Value -ne \$identity\.Value\)\s*\{\s*$/,
    );
  });
});

const roots: string[] = [];
const workdir = (): string => {
  const value = mkdtempSync(join(tmpdir(), "lohra-private-home-"));
  roots.push(value);
  return value;
};

function withPlatform<T>(platform: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

describe("creators of the home and the profile directory", () => {
  const guard = vi.mocked(ensureWindowsPrivateDirectory);
  const subdirectories = ["memories", "skills", "cron", "logs", "plugins"];
  // Stands in for the native primitive: records whether the directory was
  // still absent when the guard ran, then creates it like the real one would.
  const seen: boolean[] = [];
  const createLikeNative = (directory: string): void => {
    seen.push(existsSync(directory));
    mkdirSync(directory, { recursive: true });
  };

  beforeEach(() => {
    guard.mockReset();
    seen.length = 0;
  });
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
  });

  it("opens state.db only after the private home exists on Windows", () => {
    const home = join(workdir(), "home");
    guard.mockImplementationOnce(createLikeNative);
    const connection = withPlatform("win32", () => openStateDatabase(join(home, "state.db")));
    connection.close();
    expect(guard).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledWith(home);
    expect(seen).toEqual([false]);
    expect(existsSync(join(home, "state.db"))).toBe(true);
  });

  it("does not open state.db when the private home is refused", () => {
    const home = join(workdir(), "home");
    guard.mockImplementationOnce(() => {
      throw new Error("private home refused");
    });
    expect(() => withPlatform("win32", () => openStateDatabase(join(home, "state.db")))).toThrow(
      "private home refused",
    );
    expect(existsSync(join(home, "state.db"))).toBe(false);
  });

  it("keeps the recursive mkdir for state.db outside Windows", () => {
    const home = join(workdir(), "nested", "home");
    const connection = withPlatform("linux", () => openStateDatabase(join(home, "state.db")));
    connection.close();
    expect(guard).not.toHaveBeenCalled();
    expect(existsSync(join(home, "state.db"))).toBe(true);
  });

  it("creates the profile directory through the guard before its subdirectories on Windows", () => {
    const home = join(workdir(), "profiles", "diag");
    guard.mockImplementationOnce(createLikeNative);
    expect(withPlatform("win32", () => ensureHome(home))).toBe(home);
    expect(guard).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledWith(home);
    expect(seen).toEqual([false]);
    expect(subdirectories.every((name) => existsSync(join(home, name)))).toBe(true);
  });

  it("does not create the subdirectories of a profile whose directory is refused", () => {
    const home = join(workdir(), "profiles", "diag");
    guard.mockImplementationOnce(() => {
      throw new Error("private profile refused");
    });
    expect(() => withPlatform("win32", () => ensureHome(home))).toThrow("private profile refused");
    expect(existsSync(join(home, "memories"))).toBe(false);
  });

  it("keeps the recursive mkdir for profile directories outside Windows", () => {
    const home = join(workdir(), "profiles", "diag");
    withPlatform("linux", () => ensureHome(home));
    expect(guard).not.toHaveBeenCalled();
    expect(subdirectories.every((name) => existsSync(join(home, name)))).toBe(true);
  });

  it("profile create reaches the guard with the profile home", () => {
    const root = workdir();
    guard.mockImplementationOnce(createLikeNative);
    const result = withPlatform("win32", () =>
      runProfile("create", "diag", { base: root, activeProfile: null }),
    );
    expect(result.code).toBe(0);
    expect(guard).toHaveBeenCalledWith(join(root, "profiles", "diag"));
  });
});
