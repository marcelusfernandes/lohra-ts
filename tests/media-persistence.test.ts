import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

  it("accepts the measured 2,097,167-byte oracle payload", { timeout: 20_000 }, async () => {
    const directory = root();
    const bytes = Buffer.alloc(2_097_167, 0x41);
    const paths = await persistGeneratedImages({
      plan: createOutputPlan(join(directory, "images")),
      payloads: [bytes.toString("base64")],
      requested: 1,
      uuid: () => "e".repeat(32),
    });
    expect(readFileSync(paths[0] ?? "")).toEqual(bytes);
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
        beforePublish: (index) => {
          if (index === 1) throw new Error("publish fault");
        },
      }),
    ).rejects.toThrow("publish fault");
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(existsSync(join(outDir, `${"a".repeat(32)}.png`))).toBe(false);
    expect(existsSync(join(outDir, `${"b".repeat(32)}.png`))).toBe(false);
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
    ).rejects.toThrow(/EEXIST|exist/i);
    expect(readFileSync(join(outDir, `${"a".repeat(32)}.png`), "utf8")).toBe("sentinel");
    expect(readdirSync(outDir)).toEqual([`${"a".repeat(32)}.png`]);
  });

  it("rejects a stage swapped for a symlink by the publish hook", async () => {
    const directory = root();
    const external = root();
    const outDir = join(directory, "images");
    const sentinel = join(external, "sentinel.png");
    writeFileSync(sentinel, "EXTERNAL");
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [Buffer.from("provider").toString("base64")],
        requested: 1,
        uuid: () => "a".repeat(32),
        beforePublish: () => {
          const stage = readdirSync(outDir).find((name) => name.startsWith(".stage-"));
          if (stage === undefined) throw new Error("stage missing in hook");
          rmSync(join(outDir, stage));
          symlinkSync(sentinel, join(outDir, stage));
        },
      }),
    ).rejects.toThrow("staged image changed after publish hook");
    expect(existsSync(join(outDir, `${"a".repeat(32)}.png`))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("EXTERNAL");
    expect(readdirSync(external)).toEqual(["sentinel.png"]);
  });

  it("rejects a stage whose bytes or identity changed after the publish hook", async () => {
    const directory = root();
    const outDir = join(directory, "images");
    await expect(
      persistGeneratedImages({
        plan: createOutputPlan(outDir),
        payloads: [Buffer.from("provider").toString("base64")],
        requested: 1,
        uuid: () => "a".repeat(32),
        beforePublish: () => {
          const stage = readdirSync(outDir).find((name) => name.startsWith(".stage-"));
          if (stage === undefined) throw new Error("stage missing in hook");
          writeFileSync(join(outDir, stage), "tampered");
        },
      }),
    ).rejects.toThrow("staged image changed after publish hook");
    expect(existsSync(join(outDir, `${"a".repeat(32)}.png`))).toBe(false);
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
        writeStage: (fd, bytes) => {
          writeFileSync(fd, bytes.subarray(0, 7));
          throw new Error("fault after 7 bytes");
        },
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
