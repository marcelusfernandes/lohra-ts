// Issue #957 (épico #899, ADR 0006; decisão do owner na #947): um diretório (e um
// destino) que JÁ EXISTIA é aceito quando todas as regras da DACL, herdadas ou
// não, são Allow para o usuário, SYSTEM ou Administradores, o dono é o usuário e
// ele tem controle total. O que o Lohra cria ou protege na chamada continua com a
// verificação estrita (sem herança), a que a #953 prendeu em
// windows-acl-batch.test.ts. Quando alguma regra dá acesso a outra identidade, a
// recusa lista quem é e diz o que fazer. Três blocos: o módulo com operações
// injetadas (qual verificação cada objeto recebe e quantas viagens a gravação
// custa), o protocolo e o script de ACL, e o mecanismo real em pastas
// descartáveis no Windows (um pai protegido só para o usuário e um filho com
// `mkdir` comum, que herda só dele).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { atomicWritePrivate0600, type AtomicWriteOperations } from "../src/auth/json-file.js";
import { writeTokens } from "../src/auth/store.js";
import { OAuthTokens } from "../src/auth/types.js";
import {
  prepareWindowsPrivateDestination,
  type WindowsProtectionOperations,
} from "../src/security/windows-file-protection.js";
import {
  ACL_SCRIPT,
  assertAclBatch,
  encodeAclRequests,
  runWindowsAclBatch,
  windowsPowerShellCommand,
  type WindowsAclRequest,
} from "../src/security/windows-file-protection-native.js";

// `writeTokens` (a renovação do OAuth) grava por `atomicWritePrivate0600(path, data)`
// com as operações reais. Aqui ele recebe as operações injetadas pelo teste, e o
// caminho que o `join` do SO monta (barra normal fora do Windows) vira o do Windows.
const injected = vi.hoisted(() => ({ operations: undefined as AtomicWriteOperations | undefined }));
vi.mock("../src/auth/json-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/json-file.js")>();
  return {
    ...actual,
    atomicWritePrivate0600: (path: string, data: string, operations?: AtomicWriteOperations) => {
      actual.atomicWritePrivate0600(
        injected.operations === undefined ? path : path.replaceAll("/", "\\"),
        data,
        operations ?? injected.operations,
      );
    },
  };
});

afterEach(() => {
  injected.operations = undefined;
});

const vault = "C:\\vault";
const target = `${vault}\\auth.json`;
const staged = `${target}.tmp-1-2`;
const oauth = `${vault}\\oauth.json`;
const oauthStaged = `${oauth}.tmp-1-2`;

type Kind = "file" | "directory";
// "inherits-approved": nothing protected, every inherited rule is the user's, SYSTEM's
// or the Administrators'. "inherits-other": some rule gives access to someone else.
type Acl = "protected" | "inherits-approved" | "inherits-other";

/**
 * Models the real backend. `protect` applies and verifies by itself and a batch is
 * one trip (one process); a fresh `mkdir` or create inherits until it is protected.
 * `verify` accepts what the script accepts: an object protected without inheritance
 * always, an object that only inherits approved identities when it is `preexisting`.
 * A trip lists its requests, a `*` after the action marking `preexisting`, so a test
 * pins which check each object gets and how many processes a write costs.
 */
function backend(present: ReadonlyArray<readonly [path: string, kind: Kind, acl: Acl]> = []) {
  let nextId = 1;
  const entries = new Map<string, { kind: Kind; identity: string; size: bigint }>();
  const acls = new Map<string, Acl>();
  const descriptors = new Map<number, string>();
  const trips: string[] = [];
  const changes: string[] = [];
  const written: string[] = [];
  const add = (path: string, kind: Kind, acl: Acl) => {
    entries.set(path, { kind, identity: String(nextId++), size: 0n });
    acls.set(path, acl);
  };
  for (const [path, kind, acl] of present) add(path, kind, acl);
  const label = ({ action, path, preexisting }: WindowsAclRequest) =>
    `${action}${preexisting === true ? "*" : ""} ${path}`;
  const refuse = (path: string, preexisting: boolean) => {
    const acl = acls.get(path);
    if (acl === "protected" || (acl === "inherits-approved" && preexisting)) return;
    throw new Error(`ACL refused (${acl ?? "unknown"}): ${path}`);
  };
  const operations: WindowsProtectionOperations = {
    platform: "win32",
    protectVerifies: true,
    batch: (requests) => {
      trips.push(requests.map(label).join(" + "));
      for (const { action, path, preexisting } of requests) {
        if (action === "verify") refuse(path, preexisting === true);
      }
    },
    volume: () => {
      throw new Error("every volume check goes through a batch");
    },
    inspect: (path) => entries.get(path) ?? null,
    mkdir: (path) => {
      changes.push(`mkdir ${path}`);
      add(path, "directory", "inherits-approved");
    },
    createEmpty: (path) => {
      changes.push(`create ${path}`);
      add(path, "file", "inherits-approved");
    },
    openWrite: (path) => {
      const descriptor = 100 + descriptors.size;
      descriptors.set(descriptor, entries.get(path)?.identity ?? "missing");
      return descriptor;
    },
    descriptorIdentity: (descriptor) => descriptors.get(descriptor) ?? "missing",
    close: () => {},
    protect: (path) => {
      trips.push(`protect ${path}`);
      changes.push(`protect ${path}`);
      acls.set(path, "protected");
    },
    verify: () => {
      throw new Error("every verification goes through a batch");
    },
    removeFile: (path) => {
      entries.delete(path);
      acls.delete(path);
    },
    removeDirectory: (path) => {
      entries.delete(path);
      acls.delete(path);
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
      written.push(bytes.toString("utf8"));
      return bytes.length - offset;
    },
    fsync: () => {},
    close: () => {},
    rename: (source, destination) => {
      const moved = entries.get(source);
      if (!moved) throw new Error("missing staged file");
      entries.set(destination, moved);
      acls.set(destination, acls.get(source) ?? "protected");
      entries.delete(source);
      acls.delete(source);
    },
    unlink: () => {},
    pid: 1,
    now: () => 2,
  };
  return { operations, write, entries, acls, trips, changes, written };
}

const approvedHome = [
  [vault, "directory", "inherits-approved"],
  [target, "file", "inherits-approved"],
] as const;

// Renewing a file that already exists: six processes, as before, with the checks on the
// preexisting directory and destination relaxed, and the stage and the published file strict.
const renewalTrips = (destination: string, stage: string) => [
  `volume ${destination} + verify* ${vault} + verify* ${destination}`,
  `volume ${stage} + verify* ${vault}`,
  `protect ${stage}`,
  `verify* ${vault} + verify ${stage}`,
  `verify* ${vault} + verify* ${destination} + verify ${stage}`,
  `verify* ${vault} + verify ${destination}`,
];

describe("windows private destination: preexisting objects, injected operations", () => {
  it("replaces a preexisting destination in a preexisting home that only inherits approved identities", () => {
    const state = backend(approvedHome);
    atomicWritePrivate0600(target, "fictional-token", state.write);
    expect(state.trips).toEqual(renewalTrips(target, staged));
    expect(state.written).toEqual(["fictional-token"]);
    // Nothing on the preexisting directory changed; the file now there is the protected stage.
    expect(state.acls.get(vault)).toBe("inherits-approved");
    expect(state.acls.get(target)).toBe("protected");
    expect(state.changes).toEqual([`create ${staged}`, `protect ${staged}`]);
  });

  it("renews the OAuth tokens (writeTokens) through the same relaxed path, in the same trips", () => {
    const state = backend([
      [vault, "directory", "inherits-approved"],
      [oauth, "file", "inherits-approved"],
    ]);
    injected.operations = state.write;
    writeTokens(vault, new OAuthTokens("fictional-access", "fictional-refresh", "account", 2000));
    expect(state.trips).toEqual(renewalTrips(oauth, oauthStaged));
    expect(state.written).toHaveLength(1);
    expect(state.written[0]).toContain("fictional-access");
    expect(state.acls.get(vault)).toBe("inherits-approved");
    expect(state.acls.get(oauth)).toBe("protected");
  });

  it("verifies strictly the destination it creates in a preexisting home, and the stage", () => {
    const state = backend([[vault, "directory", "inherits-approved"]]);
    atomicWritePrivate0600(target, "fictional-token", state.write);
    expect(state.trips).toEqual([
      `volume ${target} + verify* ${vault}`,
      `protect ${target}`,
      `volume ${staged} + verify* ${vault}`,
      `protect ${staged}`,
      `verify* ${vault} + verify ${staged}`,
      `verify* ${vault} + verify ${target} + verify ${staged}`,
      `verify* ${vault} + verify ${target}`,
    ]);
    expect(state.acls.get(vault)).toBe("inherits-approved");
  });

  it("verifies strictly everything it creates, the home included, in the call that created it", () => {
    const state = backend();
    atomicWritePrivate0600(target, "fictional-token", state.write);
    expect(state.trips).toEqual([
      `volume ${target}`,
      `protect ${vault}`,
      `protect ${target}`,
      // The stage is prepared by a second call, which finds the home already there.
      `volume ${staged} + verify* ${vault}`,
      `protect ${staged}`,
      `verify* ${vault} + verify ${staged}`,
      // The call that created the home and the destination never relaxes either.
      `verify ${vault} + verify ${target} + verify ${staged}`,
      `verify ${vault} + verify ${target}`,
    ]);
    expect(state.acls.get(vault)).toBe("protected");
  });

  it("refuses a preexisting home that gives access to another identity before creating anything", () => {
    const state = backend([[vault, "directory", "inherits-other"]]);
    let caught: unknown;
    try {
      atomicWritePrivate0600(target, "fictional-token", state.write);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("Could not save private credentials");
    expect(String((caught as Error).cause)).toContain(`ACL refused (inherits-other): ${vault}`);
    expect(state.trips).toEqual([`volume ${target} + verify* ${vault}`]);
    expect(state.changes).toEqual([]);
    expect(state.entries.has(target)).toBe(false);
  });

  it("hands the flag to a backend without batch, and keeps verify(path) alone for strict checks", () => {
    const state = backend(approvedHome);
    const volume = vi.fn();
    const verify = vi.fn();
    const verifyMany = vi.fn();
    const preexisting: WindowsProtectionOperations = {
      ...state.operations,
      volume,
      verify,
      verifyMany,
    };
    delete preexisting.batch;
    prepareWindowsPrivateDestination(target, preexisting);
    expect(volume).toHaveBeenCalledWith(target);
    expect(verify.mock.calls).toEqual([
      [vault, true],
      [target, true],
    ]);
    expect(verifyMany).not.toHaveBeenCalled();

    const created = backend();
    const strict = vi.fn();
    const verifiesAfterProtect: WindowsProtectionOperations = {
      ...created.operations,
      protectVerifies: false,
      volume: vi.fn(),
      verify: strict,
    };
    delete verifiesAfterProtect.batch;
    prepareWindowsPrivateDestination(target, verifiesAfterProtect);
    expect(strict.mock.calls).toEqual([[vault], [target]]);
  });
});

describe("windows ACL protocol: the preexisting flag", () => {
  it("encodes the flag as a third field, only when set", () => {
    const payload = encodeAclRequests([
      { action: "verify", path: "D:\\x", preexisting: true },
      { action: "verify", path: "D:\\y" },
      { action: "verify", path: "D:\\z", preexisting: false },
    ]);
    const lines = payload
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split(" "));
    expect(lines.map((fields) => fields.length)).toEqual([3, 2, 2]);
    expect(lines[0]?.[2]).toBe("preexisting");
    expect(Buffer.from(lines[0]?.[1] ?? "", "base64").toString("utf8")).toBe("D:\\x");
  });

  it("refuses the flag on anything but a verification, before launching a backend", () => {
    for (const action of ["protect", "volume"] as const) {
      expect(() => {
        assertAclBatch([{ action, path: vault, preexisting: true }]);
      }).toThrow(/preexisting/);
      expect(() => {
        runWindowsAclBatch([{ action, path: vault, preexisting: true }]);
      }).toThrow(/preexisting/);
    }
    expect(() => {
      assertAclBatch([
        { action: "volume", path: target },
        { action: "verify", path: vault, preexisting: true },
        { action: "verify", path: target, preexisting: true },
      ]);
    }).not.toThrow();
  });

  it("keeps the approved identities of the preexisting check the same as the strict one", () => {
    // The strict checks stay verbatim in the script (windows-acl-batch pins their place);
    // the preexisting check names the same identities again, so a change to one shows here.
    expect(ACL_SCRIPT.match(/'S-1-5-18'/g)).toHaveLength(2);
    expect(ACL_SCRIPT.match(/'S-1-5-32-544'/g)).toHaveLength(2);
  });
});

// Real mechanism, throwaway folders under the OS temp dir (never a profile or a home).
describe("windows ACL mechanism: preexisting folders that inherit", () => {
  const windows = process.platform === "win32";
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  // An elevated process owns what it creates as the Administrators group, which the
  // policy refuses as "owner differs": the accepting cases need the user as owner.
  const elevated =
    windows &&
    spawnSync(join(system32, "whoami.exe"), ["/groups"], { encoding: "utf8" }).stdout.includes(
      "S-1-16-12288",
    );
  const windowsOnly = it.runIf(windows);
  const owned = it.runIf(windows && !elevated);
  const roots: string[] = [];
  afterAll(() => {
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  const throwaway = (): string => {
    const path = mkdtempSync(join(tmpdir(), "lohra-heranca-"));
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
  const GRANT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$acl = [System.IO.Directory]::GetAccessControl($env:LOHRA_TEST_TARGET)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  [System.Security.Principal.SecurityIdentifier]::new($env:LOHRA_TEST_SID),
  [System.Security.AccessControl.FileSystemRights]'Read',
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]$env:LOHRA_TEST_TYPE
)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($env:LOHRA_TEST_TARGET, $acl)
`;
  const script = (text: string) => Buffer.from(text, "utf16le").toString("base64");
  // Adds a rule on a throwaway folder (the real mechanism has no verb for it).
  const addRule = (folder: string, sid: string, type: "Allow" | "Deny") => {
    const command = windowsPowerShellCommand(process.env);
    const result = spawnSync(
      command.executable,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", script(GRANT_SCRIPT)],
      {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...command.environment,
          LOHRA_TEST_TARGET: folder,
          LOHRA_TEST_SID: sid,
          LOHRA_TEST_TYPE: type,
        },
      },
    );
    if (result.status !== 0)
      throw new Error(`could not add a rule on the throwaway: ${result.stderr}`);
  };
  // Every ACL operation opens a PowerShell process, and the suite runs them under load
  // against a 5 s test timeout: the parents (the protect mechanism, and the rules added to
  // them) are built once, outside any test, and each test costs one or two processes.
  const unmapped = "S-1-5-21-1-2-3-1234";
  const parents = { approved: "", others: "" };
  /** A parent only the user can reach, plus `grants`: what its plain `mkdir` children inherit. */
  const protectedParent = (grants: readonly string[]): string => {
    const parent = throwaway();
    runWindowsAclBatch([{ action: "protect", path: parent }]);
    for (const sid of grants) addRule(parent, sid, "Allow");
    return parent;
  };
  beforeAll(() => {
    if (!windows) return;
    parents.approved = protectedParent([]);
    parents.others = protectedParent(["S-1-5-32-545", unmapped]);
  });
  let created = 0;
  /** A plain `mkdir` child: it inherits from the parent alone, with no ACL of its own. */
  const inheritingChild = (parent: string): string => {
    created += 1;
    const child = join(parent, `home-${String(created)}`);
    mkdirSync(child);
    return child;
  };
  const verify = (path: string, preexisting: boolean) => {
    runWindowsAclBatch([
      { action: "volume", path: join(path, "auth.json") },
      { action: "verify", path, ...(preexisting ? { preexisting: true } : {}) },
    ]);
  };

  owned(
    "accepts a preexisting folder and file that inherit only approved identities, changing neither",
    () => {
      const home = inheritingChild(parents.approved);
      const file = join(home, "auth.json");
      writeFileSync(file, "{}");
      runWindowsAclBatch([
        { action: "volume", path: file },
        { action: "verify", path: home, preexisting: true },
        { action: "verify", path: file, preexisting: true },
      ]);
      // Nothing was applied to the folder: the strict check still refuses what only
      // inherits, with today's cause.
      expect(
        failureOf(() => {
          verify(home, false);
        }).message,
      ).toContain(`Windows ACL verify failed at ${home}: Inherited access rules remain enabled`);
    },
  );

  owned("lists every unapproved identity, by name and SID or by SID alone, and what to do", () => {
    const home = inheritingChild(parents.others);
    const failure = failureOf(() => {
      verify(home, true);
    });
    expect(failure.message).toContain(`Windows ACL verify failed at ${home}: `);
    // BUILTIN\Users in the machine language, then its SID; the SID without a name stands alone.
    expect(failure.message).toMatch(/[^\s,]+\\[^\s,]+ \(S-1-5-32-545\)/);
    expect(failure.message).toMatch(new RegExp(`[:,] ${unmapped}(?:[,.]|$)`));
    expect(failure.message).not.toContain(`(${unmapped})`);
    expect(failure.message).toMatch(/move or rename/i);
    expect(failure.message).toContain("LOHRA_HOME");
    expect(failure.message).not.toMatch(/CLIXML|<Objs/);
  });

  owned("refuses saving a credential there, creating nothing in the folder", () => {
    const home = inheritingChild(parents.others);
    const failure = failureOf(() => {
      atomicWritePrivate0600(join(home, "auth.json"), "fictional-token");
    });
    expect(failure.message).toContain("Could not save private credentials");
    expect(String(failure.cause)).toContain("(S-1-5-32-545)");
    expect(String(failure.cause)).toContain("LOHRA_HOME");
    expect(readdirSync(home)).toEqual([]);
  });

  owned("still refuses a Deny rule, with the cause of the strict check", () => {
    const home = inheritingChild(parents.approved);
    addRule(home, "S-1-5-32-546", "Deny");
    expect(
      failureOf(() => {
        verify(home, true);
      }).message,
    ).toContain(`Windows ACL verify failed at ${home}: Deny access rule cannot be verified`);
  });

  windowsOnly(
    "still refuses a folder owned by someone else, with the cause of the strict check",
    () => {
      // The Windows folder belongs to TrustedInstaller; it is only read.
      const folder = process.env.SystemRoot ?? "C:\\Windows";
      expect(
        failureOf(() => {
          verify(folder, true);
        }).message,
      ).toContain(
        `Windows ACL verify failed at ${folder}: Windows file owner differs from the current identity`,
      );
    },
  );

  windowsOnly("still refuses a reparse point, with the cause of the strict check", () => {
    const root = throwaway();
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link, "junction");
    expect(
      failureOf(() => {
        verify(link, true);
      }).message,
    ).toContain(`Windows ACL verify failed at ${link}: Windows reparse point is not verifiable`);
  });

  windowsOnly(
    "never takes the preexisting branch for protect, even when the line asks for it",
    () => {
      const folder = throwaway();
      const command = windowsPowerShellCommand(process.env);
      const lines = encodeAclRequests([{ action: "protect", path: folder, preexisting: true }]);
      const result = spawnSync(
        command.executable,
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", script(ACL_SCRIPT)],
        { input: lines, encoding: "utf8", env: command.environment, windowsHide: true },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown ACL option");
      // The folder was not touched: it still only inherits.
      expect(existsSync(folder)).toBe(true);
      expect(
        failureOf(() => {
          verify(folder, false);
        }).message,
      ).toContain("Inherited access rules");
    },
  );
});
