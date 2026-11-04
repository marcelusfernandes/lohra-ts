import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOutputPlan,
  persistGeneratedImages,
  type MediaWindowsProtection,
} from "../src/media/index.js";
import type { WindowsFileProtection } from "../src/security/windows-file-protection.js";

// ADR 0006 item 3: mídia é privada por padrão no Windows. Estes casos rodam em
// qualquer plataforma: a proteção é injetada (como `prepare` em
// `atomicWritePrivate0600`) sobre arquivos reais de um diretório temporário,
// então ordem, limpeza e causa são verificadas sem abrir um powershell.exe.

const roots: string[] = [];
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "lohra-media-windows-"));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

type Step = "ensure" | "prepare" | "open" | "verify-before" | "verify-after";

/** Proteção fake: arquivos reais, "protegido" é um conjunto, cada passo é registrado. */
function fixture(onStep: (step: Step, label: string) => void = () => undefined) {
  const events: string[] = [];
  const protectedPaths = new Set<string>();
  const label = (path: string): string => {
    const name = basename(path);
    return name.startsWith(".stage-") ? "stage" : `final-${name.slice(0, 1)}`;
  };
  const record = (step: Step, path: string): void => {
    const name = label(path);
    events.push(`${step}:${name}`);
    onStep(step, name);
  };
  const protection: MediaWindowsProtection = {
    ensureDirectory: (directory) => {
      events.push("ensure");
      onStep("ensure", "directory");
      mkdirSync(directory, { recursive: true });
      protectedPaths.add(directory);
    },
    prepare: (path, options) => {
      expect(options).toEqual({ exclusive: true });
      record("prepare", path);
      closeSync(openSync(path, "wx"));
      protectedPaths.add(path);
      let source = "";
      let stagedIdentity = 0;
      const guard: WindowsFileProtection = {
        verifyBeforeWrite: () => undefined,
        openOwnedForWrite: () => {
          record("open", path);
          // Os bytes só chegam por este descritor: o arquivo já está protegido e vazio.
          expect(protectedPaths.has(path)).toBe(true);
          expect(statSync(path).size).toBe(0);
          return openSync(path, "r+");
        },
        verifyBeforePublication: (stage) => {
          record("verify-before", path);
          // Nada foi renomeado ainda: o destino segue o arquivo vazio e protegido.
          expect(existsSync(stage)).toBe(true);
          expect(statSync(path).size).toBe(0);
          expect(protectedPaths.has(stage) && protectedPaths.has(path)).toBe(true);
          source = stage;
          stagedIdentity = statSync(stage).ino;
        },
        verifyAfterPublication: () => {
          record("verify-after", path);
          expect(existsSync(source)).toBe(false);
          expect(statSync(path).ino).toBe(stagedIdentity);
        },
        removeOwned: () => {
          rmSync(path);
        },
      };
      return guard;
    },
  };
  return { protection, events };
}

const payload = (text: string): string => Buffer.from(text).toString("base64");
const ids = (...letters: string[]): (() => string) => {
  const queue = letters.map((letter) => letter.repeat(32));
  return () => queue.shift() ?? "f".repeat(32);
};
const png = (letter: string): string => `${letter.repeat(32)}.png`;

describe("media privacy on Windows (ADR 0006)", () => {
  it("protects directory, destination and stage before any byte, then verifies the published file", async () => {
    const directory = root();
    const plan = createOutputPlan(join(directory, "images"));
    const state = fixture();
    const paths = await persistGeneratedImages({
      plan,
      payloads: [payload("first")],
      requested: 1,
      uuid: ids("a"),
      beforePublish: () => {
        state.events.push("hook");
      },
      windowsProtection: state.protection,
    });
    expect(paths).toEqual([join(plan.outDir, png("a"))]);
    expect(readFileSync(join(plan.outDir, png("a")), "utf8")).toBe("first");
    expect(readdirSync(plan.outDir)).toEqual([png("a")]);
    expect(state.events).toEqual([
      "ensure",
      "hook",
      "prepare:final-a",
      "prepare:stage",
      "open:stage",
      "verify-before:final-a",
      "verify-after:final-a",
    ]);
  });

  it("protects every image of a batch before its bytes and verifies each publication", async () => {
    const directory = root();
    const plan = createOutputPlan(join(directory, "images"));
    const state = fixture();
    const paths = await persistGeneratedImages({
      plan,
      payloads: [payload("one"), payload("two")],
      requested: 2,
      uuid: ids("a", "b"),
      windowsProtection: state.protection,
    });
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(["one", "two"]);
    expect(readdirSync(plan.outDir).sort()).toEqual([png("a"), png("b")]);
    expect(state.events).toEqual([
      "ensure",
      "prepare:final-a",
      "prepare:stage",
      "open:stage",
      "prepare:final-b",
      "prepare:stage",
      "open:stage",
      "verify-before:final-a",
      "verify-after:final-a",
      "verify-before:final-b",
      "verify-after:final-b",
    ]);
  });

  it("refuses to create the output directory unprotected and keeps the cause", async () => {
    const directory = root();
    const plan = createOutputPlan(join(directory, "images"));
    const failure = new Error("Could not create a private Windows directory", {
      cause: new Error("acl denied"),
    });
    const state = fixture((step) => {
      if (step === "ensure") throw failure;
    });
    await expect(
      persistGeneratedImages({
        plan,
        payloads: [payload("secret")],
        requested: 1,
        windowsProtection: state.protection,
      }),
    ).rejects.toBe(failure);
    expect(state.events).toEqual(["ensure"]);
    expect(existsSync(plan.outDir)).toBe(false);
  });

  it.each<[string, Step, string]>([
    ["the stage cannot be protected", "prepare", "stage"],
    ["the stage cannot be opened", "open", "stage"],
  ])("leaves no file behind when %s", async (_name, failing, failingLabel) => {
    const directory = root();
    const plan = createOutputPlan(join(directory, "images"));
    const failure = new Error(`${failing} refused`, { cause: new Error("acl denied") });
    const state = fixture((step, name) => {
      if (step === failing && name === failingLabel) throw failure;
    });
    await expect(
      persistGeneratedImages({
        plan,
        payloads: [payload("secret")],
        requested: 1,
        uuid: ids("a"),
        windowsProtection: state.protection,
      }),
    ).rejects.toBe(failure);
    expect(readdirSync(plan.outDir)).toEqual([]);
  });

  it("does not publish when the protection cannot be verified before the rename", async () => {
    const directory = root();
    const plan = createOutputPlan(join(directory, "images"));
    const failure = new Error("incompatible ACL", { cause: new Error("inherited access") });
    const state = fixture((step) => {
      if (step === "verify-before") throw failure;
    });
    await expect(
      persistGeneratedImages({
        plan,
        payloads: [payload("secret")],
        requested: 1,
        uuid: ids("a"),
        windowsProtection: state.protection,
      }),
    ).rejects.toBe(failure);
    expect(readdirSync(plan.outDir)).toEqual([]);
    expect(state.events.at(-1)).toBe("verify-before:final-a");
  });

  it("removes the published file when its protection cannot be verified afterwards", async () => {
    const directory = root();
    const plan = createOutputPlan(join(directory, "images"));
    const failure = new Error("published ACL changed", { cause: new Error("inherited access") });
    const state = fixture((step) => {
      if (step === "verify-after") throw failure;
    });
    await expect(
      persistGeneratedImages({
        plan,
        payloads: [payload("secret")],
        requested: 1,
        uuid: ids("a"),
        windowsProtection: state.protection,
      }),
    ).rejects.toBe(failure);
    expect(readdirSync(plan.outDir)).toEqual([]);
  });

  it("leaves no earlier image published when a later one fails verification", async () => {
    const directory = root();
    const plan = createOutputPlan(join(directory, "images"));
    const failure = new Error("incompatible ACL");
    const state = fixture((step, name) => {
      if (step === "verify-before" && name === "final-b") throw failure;
    });
    await expect(
      persistGeneratedImages({
        plan,
        payloads: [payload("one"), payload("two")],
        requested: 2,
        uuid: ids("a", "b"),
        windowsProtection: state.protection,
      }),
    ).rejects.toBe(failure);
    expect(readdirSync(plan.outDir)).toEqual([]);
  });

  it("cleans only its own files when a foreign file replaces the final before cleanup", async () => {
    const directory = root();
    const plan = createOutputPlan(join(directory, "images"));
    const final = join(plan.outDir, png("a"));
    const failure = new Error("published ACL changed");
    const state = fixture((step) => {
      if (step !== "verify-after") return;
      const foreign = join(directory, "foreign.tmp");
      writeFileSync(foreign, "FOREIGN");
      renameSync(foreign, final);
      throw failure;
    });
    await expect(
      persistGeneratedImages({
        plan,
        payloads: [payload("secret")],
        requested: 1,
        uuid: ids("a"),
        windowsProtection: state.protection,
      }),
    ).rejects.toBe(failure);
    expect(readFileSync(final, "utf8")).toBe("FOREIGN");
    expect(readdirSync(plan.outDir)).toEqual([png("a")]);
  });

  it("keeps the root identity check: a swapped root gets no destination or stage", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const moved = join(directory, "moved");
    const state = fixture();
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [payload("secret")],
        requested: 1,
        uuid: ids("a"),
        beforePublish: () => {
          renameSync(outDir, moved);
          mkdirSync(outDir);
        },
        windowsProtection: state.protection,
      }),
    ).rejects.toThrow("output root changed after publish hook");
    expect(state.events).toEqual(["ensure"]);
    expect(readdirSync(moved)).toEqual([]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("keeps the collision check: an existing final is never adopted or removed", async () => {
    const directory = root();
    const plan = createOutputPlan(join(directory, "images"));
    const state = fixture();
    await expect(
      persistGeneratedImages({
        plan,
        payloads: [payload("secret")],
        requested: 1,
        uuid: ids("a"),
        beforePublish: (_index, final) => {
          writeFileSync(final, "FOREIGN-FINAL");
        },
        windowsProtection: state.protection,
      }),
    ).rejects.toThrow(/collision/i);
    expect(readFileSync(join(plan.outDir, png("a")), "utf8")).toBe("FOREIGN-FINAL");
    expect(readdirSync(plan.outDir)).toEqual([png("a")]);
    expect(state.events).toEqual(["ensure"]);
  });
});
