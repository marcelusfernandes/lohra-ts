// Issue #942 (épico #899): salvar credencial no Windows com menos processos
// `powershell.exe`, sem tirar nenhuma conferência. Este arquivo prova o lote de
// pedidos de ACL (formato, codificação, forma permitida), as viagens (um processo
// cada) que o preparo de um destino gasta com um backend como o real, e o
// mecanismo real em pastas descartáveis no Windows. O contrato por operação
// continua em windows-file-protection.test.ts.
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
} from "../src/security/windows-file-protection-native.js";

const directory = "C:\\vault";
const destination = `${directory}\\secret.json`;

type Kind = "file" | "directory" | "link";

/**
 * Models the real backend: `protect` applies the ACL and verifies it by itself,
 * and a group of requests (`batch`) costs one round trip. `trips` lists the
 * round trips, so a test can pin how many processes a sequence costs.
 */
function fixture() {
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
    protectVerifies: true,
    batch: (requests) => {
      trips.push(`batch:${requests.map(({ action, path }) => `${action}:${path}`).join(",")}`);
      for (const { action, path } of requests) operations[action](path);
    },
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
      trips.push(`protect:${path}`);
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

// The module no longer calls `verify` after `protect` (the native backend declares
// `protectVerifies`), so nothing else catches a `protect` that stopped verifying.
// That guarantee lives in the script's structure: the checks sit after the end of the
// protect block, at the protect block's own nesting level (or in the one loop over the
// rules), so they run for `protect` as well as for `verify`, on the ACL read again after
// Set-Acl. Moving a check into a branch of one action, or ahead of the re-read, fails here.
describe("windows ACL script: protect verifies what it applied", () => {
  // Header lines of the blocks that enclose `index`, outermost first.
  const enclosingBlocks = (script: string, index: number): string[] => {
    const blocks: string[] = [];
    for (let at = 0; at < index; at += 1) {
      if (script[at] === "{") {
        blocks.push(script.slice(script.lastIndexOf("\n", at) + 1, at + 1).trim());
      } else if (script[at] === "}") {
        blocks.pop();
      }
    }
    return blocks;
  };
  const matchingClose = (script: string, open: number): number => {
    let depth = 0;
    for (let at = open; at < script.length; at += 1) {
      if (script[at] === "{") depth += 1;
      else if (script[at] === "}" && --depth === 0) return at;
    }
    return -1;
  };
  const onceAt = (needle: string): number => {
    const first = ACL_SCRIPT.indexOf(needle);
    expect(first, `script lacks: ${needle}`).toBeGreaterThanOrEqual(0);
    expect(ACL_SCRIPT.indexOf(needle, first + 1), `script repeats: ${needle}`).toBe(-1);
    return first;
  };

  const protectHeader = "if ($request.action -eq 'protect') {";
  const loopHeader = "foreach ($rule in $rules) {";
  const locateProtect = () => {
    const start = onceAt(protectHeader);
    const open = start + protectHeader.length - 1;
    return { start, open, close: matchingClose(ACL_SCRIPT, open) };
  };

  it("reads the braces of the script as balanced blocks", () => {
    const { start: protectStart, open: protectOpen, close: protectClose } = locateProtect();
    expect(protectClose).toBeGreaterThan(protectOpen);
    expect(enclosingBlocks(ACL_SCRIPT, ACL_SCRIPT.length)).toEqual([]);
    expect(enclosingBlocks(ACL_SCRIPT, protectOpen + 1)).toEqual([
      ...enclosingBlocks(ACL_SCRIPT, protectStart),
      protectHeader,
    ]);
  });

  it("re-reads the ACL after Set-Acl, inside the protect block", () => {
    const { open: protectOpen, close: protectClose } = locateProtect();
    const setAcl = onceAt("Set-Acl -LiteralPath $path -AclObject $acl");
    const reread = ACL_SCRIPT.indexOf("$acl = Read-Acl $path", setAcl);
    expect(setAcl).toBeGreaterThan(protectOpen);
    expect(reread).toBeGreaterThan(setAcl);
    expect(reread).toBeLessThan(protectClose);
  });

  it("falls through to the checks: the protect block never leaves the request early", () => {
    const { open: protectOpen, close: protectClose } = locateProtect();
    expect(ACL_SCRIPT.slice(protectOpen, protectClose)).not.toMatch(
      /\b(continue|break|return|exit)\b/i,
    );
  });

  it.each([
    { check: "rules still inherited", anchor: "if (-not $acl.AreAccessRulesProtected)" },
    { check: "owner is not the identity", anchor: "if ($owner.Value -ne $identity.Value)" },
    { check: "empty DACL", anchor: "if ($rules.Count -eq 0)" },
    { check: "inherited rule", anchor: "if ($rule.IsInherited)", inLoop: true },
    { check: "deny rule", anchor: "if ($rule.AccessControlType -ne 'Allow')", inLoop: true },
    {
      check: "unapproved identity",
      anchor: "$sid -ne $identity.Value -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544'",
      inLoop: true,
    },
    {
      check: "full control tally",
      anchor: "$ownerCanUpdate = $true",
      inLoop: true,
      insideIf: "-eq $fullControl) {",
    },
    { check: "owner lacks full control", anchor: "if (-not $ownerCanUpdate)" },
  ])(
    "runs the $check check after the protect block, for protect and verify alike",
    ({ anchor, inLoop, insideIf }) => {
      const { start: protectStart, close: protectClose } = locateProtect();
      const at = onceAt(anchor);
      expect(at).toBeGreaterThan(protectClose);
      const parents = enclosingBlocks(ACL_SCRIPT, protectStart);
      const blocks = enclosingBlocks(ACL_SCRIPT, at);
      expect(blocks.slice(0, parents.length)).toEqual(parents);
      if (inLoop === true) {
        // Exactly the loop over the rules (plus the one condition of the tally): no
        // extra condition on the action may wrap the check.
        expect(blocks[parents.length]).toBe(loopHeader);
        expect(blocks).toHaveLength(parents.length + 1 + (insideIf === undefined ? 0 : 1));
        if (insideIf !== undefined) expect(blocks.at(-1)?.endsWith(insideIf)).toBe(true);
      } else {
        expect(blocks).toEqual(parents);
      }
    },
  );
});

// Issue #942: the same checks, in fewer round trips. A "trip" is one backend
// process on Windows; the fixture counts the ones the real backend would open.
describe("windows private destination round trips", () => {
  it("creates a private directory and file in three trips: protect already verifies", () => {
    const state = fixture();
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
    const state = fixture();
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
    const state = fixture();
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
    const state = fixture();
    state.add(directory, "directory");
    state.protectedPaths.add(directory);
    state.add(destination, "file", 5n);
    expect(() =>
      prepareWindowsPrivateDestination(destination, state.operations, { exclusive: true }),
    ).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(state.trips).toEqual([`batch:volume:${destination},verify:${directory}`]);
  });

  it("refuses a volume that rides with the first verification before anything is created", () => {
    const state = fixture();
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

  it("keeps the identity check after a protect that already verified", () => {
    const state = fixture();
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
    const state = fixture();
    ensureWindowsPrivateDirectory("C:\\lohra", state.operations);
    expect(state.trips).toEqual(["batch:volume:C:\\lohra", "protect:C:\\lohra"]);
    expect(state.events).not.toContain("verify:C:\\lohra");
  });

  it("keeps the identity check after the home's protect", () => {
    const state = fixture();
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
