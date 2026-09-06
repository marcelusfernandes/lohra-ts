import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_IMAGE_BATCH_BYTES,
  MAX_IMAGE_BYTES,
  createOutputPlan,
  persistGeneratedImages,
} from "../src/media/index.js";

const roots: string[] = [];
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "lohra-media-persist-"));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("staged image persistence", () => {
  it("uses the contract-required atomic rename primitive", () => {
    const source = readFileSync(new URL("../src/media/persistence.ts", import.meta.url), "utf8");
    expect(source).toContain("renameSync(temp, final);");
    expect(source).not.toContain("linkSync(temp, final);");
  });

  it.each([0o022, 0o077])(
    "sets 0644 under umask %o and never derives names from inputs",
    async (umask) => {
      const directory = root();
      const old = process.umask(umask);
      try {
        const paths = await persistGeneratedImages({
          plan: createOutputPlan(join(directory, "images")),
          payloads: [Buffer.from("png").toString("base64")],
          requested: 1,
          uuid: () => "d".repeat(32),
        });
        expect(paths).toEqual([
          join(createOutputPlan(join(directory, "images")).outDir, `${"d".repeat(32)}.png`),
        ]);
        expect(lstatSync(paths[0] ?? "").mode & 0o777).toBe(0o644);
        expect(readFileSync(paths[0] ?? "", "utf8")).toBe("png");
      } finally {
        process.umask(old);
      }
    },
  );

  it("validates every payload and batch before creating the output directory", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const plan = createOutputPlan(outDir);
    await expect(persistGeneratedImages({ plan, payloads: ["%%%"], requested: 1 })).rejects.toThrow(
      "invalid base64",
    );
    await expect(
      persistGeneratedImages({ plan, payloads: ["AB=="], requested: 1 }),
    ).rejects.toThrow("invalid base64");
    expect(existsSync(outDir)).toBe(false);

    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64");
    await expect(persistGeneratedImages({ plan, payloads: [huge], requested: 1 })).rejects.toThrow(
      "20 MiB",
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it("enforces the decoded batch cap", async () => {
    const directory = root();
    const chunk = Buffer.alloc(Math.floor(MAX_IMAGE_BATCH_BYTES / 4) + 1).toString("base64");
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(join(directory, "images")),
        payloads: [chunk, chunk, chunk, chunk],
        requested: 4,
      }),
    ).rejects.toThrow("64 MiB");
  });

  it("accepts the measured 2,097,167-byte oracle payload", async () => {
    const directory = root();
    const bytes = Buffer.alloc(2_097_167, 0x41);
    const paths = await persistGeneratedImages({
      plan: createOutputPlan(join(directory, "images")),
      payloads: [bytes.toString("base64")],
      requested: 1,
      uuid: () => "e".repeat(32),
    });
    // Byte-exact readback via Buffer.prototype.equals (memcmp, O(n)), not
    // toEqual (deep, per-element iterableEquality) — see the comment below
    // for why this matters for a ~2MB buffer.
    expect(readFileSync(paths[0] ?? "").equals(bytes)).toBe(true);
  });

  // Issue #128: sob carga (duas suítes completas em paralelo), este teste
  // reprovou com "Test timed out in 20000ms" (24890ms observados antes do
  // corte). Isolado, o trabalho real (persistGeneratedImages + readFileSync)
  // leva ~20-30ms mesmo sob carga pesada — o custo todo está em
  // `expect(...).toEqual(bytes)`: para um Buffer de ~2MB, o comparador
  // profundo do vitest (iterableEquality) percorre elemento a elemento e
  // leva ~2.7-9.3s medidos (sem carga a ~3s), contra ~0.3ms de
  // `Buffer.prototype.equals` (mesmo memcmp, mesma garantia de igualdade
  // byte-a-byte). O orçamento de 20_000ms não precisava mudar por causa do
  // payload — precisava deixar de pagar por uma comparação O(n) elemento a
  // elemento quando existe uma O(n) nativa. Meta-teste abaixo prende que
  // este teste não carrega um timeout inflado para compensar isso.
  it("budget: o teste do payload grande não precisa de um timeout inflado (issue #128)", (ctx) => {
    const nomeAlvo = "accepts the measured 2,097,167-byte oracle payload";
    const alvo = ctx.task.suite?.tasks.find((t) => t.name === nomeAlvo);
    if (alvo === undefined) throw new Error(`teste-alvo "${nomeAlvo}" não encontrado nesta suíte`);
    const timeout = (alvo as { timeout?: number }).timeout;
    expect(timeout).toBeLessThanOrEqual(5_000);
  });

  it("rejects an over-return above the global cardinality cap", async () => {
    const directory = root();
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(join(directory, "images")),
        payloads: Array.from({ length: 12 }, () => "YQ=="),
        requested: 12,
      }),
    ).rejects.toThrow("more than 10 images");
    expect(existsSync(join(directory, "images"))).toBe(false);
  });

  it("detects output-root symlink swaps at the exact hook checkpoint", async () => {
    const directory = root();
    const external = root();
    const outDir = join(directory, "images");
    const hook = vi.fn(() => {
      symlinkSync(external, outDir);
    });
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: ["cG5n"],
        requested: 1,
        afterRootPreflight: hook,
      }),
    ).rejects.toThrow("output root changed after preflight");
    expect(hook).toHaveBeenCalledOnce();
    expect(existsSync(join(external, `${"a".repeat(32)}.png`))).toBe(false);
  });

  it("cleans owned stage/finals after a later publication failure", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const ids = ["a".repeat(32), "b".repeat(32)];
    const sentinel = join(directory, "sentinel");
    writeFileSync(sentinel, "keep");
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: ["b25l", "dHdv"],
        requested: 2,
        uuid: () => ids.shift() ?? "c".repeat(32),
        beforePublish: (index, final) => {
          if (index === 1) writeFileSync(final, "FOREIGN-FINAL");
        },
      }),
    ).rejects.toThrow(/collision/i);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(existsSync(join(outDir, `${"a".repeat(32)}.png`))).toBe(false);
    expect(readFileSync(join(outDir, `${"b".repeat(32)}.png`), "utf8")).toBe("FOREIGN-FINAL");
    expect(readdirSync(outDir).filter((name) => name.startsWith(".stage-"))).toEqual([]);
    if (existsSync(outDir)) expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("never overwrites or removes a concurrently-created final", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [Buffer.from("provider").toString("base64")],
        requested: 1,
        uuid: () => "a".repeat(32),
        beforePublish: (_index, final) => {
          writeFileSync(final, "sentinel");
        },
      }),
    ).rejects.toThrow(/collision|exist/i);
    expect(readFileSync(join(outDir, `${"a".repeat(32)}.png`), "utf8")).toBe("sentinel");
    expect(readdirSync(outDir)).toEqual([`${"a".repeat(32)}.png`]);
  });

  it("runs the publish hook before any provider stage exists", async () => {
    const directory = root();
    const external = root();
    const outDir = join(directory, "images");
    const sentinel = join(external, "sentinel.png");
    writeFileSync(sentinel, "EXTERNAL");
    const decoy = join(outDir, ".stage-foreign.tmp");
    const paths = await persistGeneratedImages({
      plan: createOutputPlan(outDir),
      payloads: [Buffer.from("provider").toString("base64")],
      requested: 1,
      uuid: () => "a".repeat(32),
      beforePublish: () => {
        expect(readdirSync(outDir).filter((name) => name.startsWith(".stage-"))).toEqual([]);
        symlinkSync(sentinel, decoy);
      },
    });
    expect(readFileSync(paths[0] ?? "", "utf8")).toBe("provider");
    expect(readFileSync(sentinel, "utf8")).toBe("EXTERNAL");
    expect(readdirSync(external)).toEqual(["sentinel.png"]);
    expect(lstatSync(decoy).isSymbolicLink()).toBe(true);
  });

  it("does not let a stage-like hook decoy affect provider bytes", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const decoy = join(outDir, ".stage-decoy.tmp");
    const paths = await persistGeneratedImages({
      plan: createOutputPlan(outDir),
      payloads: [Buffer.from("provider").toString("base64")],
      requested: 1,
      uuid: () => "a".repeat(32),
      beforePublish: () => {
        expect(readdirSync(outDir).filter((name) => name.startsWith(".stage-"))).toEqual([]);
        writeFileSync(decoy, "tampered");
      },
    });
    expect(readFileSync(paths[0] ?? "", "utf8")).toBe("provider");
    expect(readFileSync(decoy, "utf8")).toBe("tampered");
  });

  it("preserves a foreign stage-like file when publication later fails", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const foreign = join(outDir, ".stage-foreign.tmp");
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [Buffer.from("provider").toString("base64")],
        requested: 1,
        uuid: () => "a".repeat(32),
        beforePublish: (_index, final) => {
          writeFileSync(foreign, "FOREIGN-SENTINEL");
          writeFileSync(final, "FOREIGN-FINAL");
        },
      }),
    ).rejects.toThrow(/collision/i);
    expect(readFileSync(join(outDir, `${"a".repeat(32)}.png`), "utf8")).toBe("FOREIGN-FINAL");
    expect(readFileSync(foreign, "utf8")).toBe("FOREIGN-SENTINEL");
  });

  it("publishes 0644 even when the hook changes a stage-like decoy mode", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const paths = await persistGeneratedImages({
      plan: createOutputPlan(outDir),
      payloads: [Buffer.from("provider").toString("base64")],
      requested: 1,
      uuid: () => "a".repeat(32),
      beforePublish: () => {
        const decoy = join(outDir, ".stage-decoy.tmp");
        writeFileSync(decoy, "foreign");
        chmodSync(decoy, 0o600);
      },
    });
    expect(lstatSync(paths[0] ?? "").mode & 0o777).toBe(0o644);
  });

  it("fails closed with zero residue when outDir is replaced without a symlink", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const moved = join(directory, "moved");
    const payload = Buffer.from("PRIVATE-PROVIDER-BYTES");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "FOREIGN"), "keep");
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [payload.toString("base64")],
        requested: 1,
        uuid: () => "d".repeat(32),
        beforePublish: () => {
          renameSync(outDir, moved);
          mkdirSync(outDir);
        },
      }),
    ).rejects.toThrow("output root changed after publish hook");
    expect(readdirSync(moved).filter((name) => name.startsWith(".stage-"))).toEqual([]);
    expect(existsSync(join(outDir, `${"d".repeat(32)}.png`))).toBe(false);
    expect(readFileSync(join(moved, "FOREIGN"), "utf8")).toBe("keep");
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("creates no owned stage when the root is replaced by a later hook", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const moved = join(directory, "moved");
    const ids = ["a".repeat(32), "b".repeat(32)];
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: ["b25l", "dHdv"],
        requested: 2,
        uuid: () => ids.shift() ?? "c".repeat(32),
        beforePublish: (index) => {
          if (index === 1) {
            renameSync(outDir, moved);
            mkdirSync(outDir);
          }
        },
      }),
    ).rejects.toThrow("output root changed after publish hook");
    const allOwned = [...readdirSync(moved), ...readdirSync(outDir)].filter(
      (name) => name.startsWith(".stage-") || name.endsWith(".png"),
    );
    expect(allOwned).toEqual([]);
    expect(existsSync(join(outDir, `${"a".repeat(32)}.png`))).toBe(false);
  });

  it("never exposes provider bytes when the publish hook relocates the root into a nested directory", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const holder = join(directory, "holder");
    const moved = join(holder, "moved");
    const payload = Buffer.from("PRIVATE-PROVIDER-BYTES");
    mkdirSync(holder);

    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [payload.toString("base64")],
        requested: 1,
        uuid: () => "e".repeat(32),
        beforePublish: () => {
          renameSync(outDir, moved);
          mkdirSync(outDir);
        },
      }),
    ).rejects.toThrow("output root changed after publish hook");

    expect(readdirSync(moved).filter((name) => name.startsWith(".stage-"))).toEqual([]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("never exposes an owned stage for a hook to hardlink", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const aliasDir = join(directory, "alias");
    const moved = join(directory, "moved");
    const payload = Buffer.from("PRIVATE-PROVIDER-BYTES");
    mkdirSync(aliasDir);
    const foreign = join(outDir, "FOREIGN");

    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [payload.toString("base64")],
        requested: 1,
        uuid: () => "e".repeat(32),
        beforePublish: () => {
          expect(readdirSync(outDir).filter((name) => name.startsWith(".stage-"))).toEqual([]);
          writeFileSync(foreign, "FOREIGN");
          linkSync(foreign, join(aliasDir, "copy"));
          renameSync(outDir, moved);
          mkdirSync(outDir);
        },
      }),
    ).rejects.toThrow("output root changed after publish hook");

    expect(readFileSync(join(aliasDir, "copy"), "utf8")).toBe("FOREIGN");
    expect(readFileSync(join(moved, "FOREIGN"), "utf8")).toBe("FOREIGN");
    expect(readdirSync(moved).filter((name) => name.startsWith(".stage-"))).toEqual([]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("cleans a relocated stage without following a replacement root symlink", async () => {
    const directory = root();
    const external = root();
    const outDir = join(directory, "images");
    const moved = join(directory, "moved");
    const payload = Buffer.from("PRIVATE-PROVIDER-BYTES");
    writeFileSync(join(external, "FOREIGN"), "keep");

    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [payload.toString("base64")],
        requested: 1,
        uuid: () => "e".repeat(32),
        beforePublish: () => {
          renameSync(outDir, moved);
          symlinkSync(external, outDir);
        },
      }),
    ).rejects.toThrow("symlink");

    expect(readdirSync(moved).filter((name) => name.startsWith(".stage-"))).toEqual([]);
    expect(readFileSync(join(external, "FOREIGN"), "utf8")).toBe("keep");
    expect(readdirSync(external)).toEqual(["FOREIGN"]);
  });

  it("does not depend on enumerating an unrelated unreadable subtree for cleanup", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    const moved = join(directory, "moved");
    const blocked = join(directory, "zzzz-blocked");
    const payload = Buffer.from("PRIVATE-PROVIDER-BYTES");
    mkdirSync(blocked);
    writeFileSync(join(blocked, "FOREIGN"), "keep");
    chmodSync(blocked, 0o000);

    try {
      await expect(
        persistGeneratedImages({
          plan: createOutputPlan(outDir),
          payloads: [payload.toString("base64")],
          requested: 1,
          uuid: () => "e".repeat(32),
          beforePublish: () => {
            renameSync(outDir, moved);
            mkdirSync(outDir);
          },
        }),
      ).rejects.toThrow("output root changed after publish hook");
    } finally {
      chmodSync(blocked, 0o700);
    }

    expect(readdirSync(moved).filter((name) => name.startsWith(".stage-"))).toEqual([]);
    expect(readFileSync(join(blocked, "FOREIGN"), "utf8")).toBe("keep");
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("removes a staged seven-byte partial after a write fault", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [Buffer.from("complete-image").toString("base64")],
        requested: 1,
        uuid: () => "f".repeat(32),
        faultAfterBytes: 7,
      }),
    ).rejects.toThrow("fault after 7 bytes");
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("rejects an existing symlink outDir but absorbs trusted parent aliases", () => {
    const directory = root();
    const external = root();
    const outDir = join(directory, "images");
    symlinkSync(external, outDir);
    expect(() => createOutputPlan(outDir)).toThrow("symlink");
    rmSync(outDir);
    mkdirSync(outDir);
    chmodSync(outDir, 0o755);
    expect(createOutputPlan(outDir).outDir).toContain("images");
  });
});
