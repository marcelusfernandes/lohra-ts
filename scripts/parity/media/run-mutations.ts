#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  MAX_DATA_URI_BASE64_CHARS,
  MAX_IMAGE_BATCH_BYTES,
  MAX_IMAGE_BYTES,
} from "../../../src/media/constants.js";
import { compareMediaRows } from "./comparator.js";

export interface MutationResult {
  readonly id: string;
  readonly killed: boolean;
  readonly observation: string;
}

interface Replacement {
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

const root = resolve(import.meta.dirname, "../../..");

function replaceRequired(path: string, from: string, to: string): void {
  const source = readFileSync(path, "utf8");
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0)
    throw new Error(`mutation anchor must occur exactly once: ${path}`);
  writeFileSync(path, source.replace(from, to));
}

async function mutantModule(
  id: string,
  entry: string,
  replacements: readonly Replacement[],
): Promise<{ readonly module: Record<string, unknown>; readonly dispose: () => void }> {
  const runtime = mkdtempSync(join(tmpdir(), `lohra-t21-mutant-${id}-`));
  const sourceRoot = join(runtime, "src");
  cpSync(join(root, "src"), sourceRoot, { recursive: true });
  writeFileSync(join(runtime, "package.json"), '{"type":"module"}\n');
  for (const replacement of replacements) {
    const path = join(sourceRoot, replacement.file);
    mkdirSync(dirname(path), { recursive: true });
    replaceRequired(path, replacement.from, replacement.to);
  }
  const module = (await import(
    `${pathToFileURL(join(sourceRoot, entry)).href}?mutation=${encodeURIComponent(id)}`
  )) as Record<string, unknown>;
  return {
    module,
    dispose: () => {
      rmSync(runtime, { recursive: true, force: true });
    },
  };
}

function compared(id: string, expected: unknown, actual: unknown): MutationResult {
  const result = compareMediaRows([{ id, value: expected }], [{ id, value: actual }])[0];
  return {
    id,
    killed: result?.pass === false,
    observation: result?.reason ?? "mutant normalized to match",
  };
}

async function persistenceMutation(
  id: string,
  replacements: readonly Replacement[],
  run: (module: {
    createOutputPlan(path: string): unknown;
    persistGeneratedImages(options: Record<string, unknown>): Promise<readonly string[]>;
  }) => Promise<{ readonly expected: unknown; readonly actual: unknown }>,
): Promise<MutationResult> {
  const loaded = await mutantModule(id, "media/persistence.ts", replacements);
  try {
    const observation = await run(loaded.module as never);
    return compared(id, observation.expected, observation.actual);
  } finally {
    loaded.dispose();
  }
}

const countGuards: readonly Replacement[] = [
  {
    file: "media/persistence.ts",
    from: "if (options.payloads.length > options.requested)",
    to: "if (false && options.payloads.length > options.requested)",
  },
  {
    file: "media/persistence.ts",
    from: "if (options.payloads.length > MAX_IMAGES)",
    to: "if (false && options.payloads.length > MAX_IMAGES)",
  },
];

export async function runMutations(): Promise<readonly MutationResult[]> {
  const results: MutationResult[] = [];

  results.push(
    await persistenceMutation("over-return", countGuards, async (media) => {
      const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-over-return-"));
      try {
        const ids = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(32, "0"));
        const paths = await media.persistGeneratedImages({
          plan: media.createOutputPlan(join(runtime, "images")),
          payloads: Array.from({ length: 12 }, () => "YQ=="),
          requested: 1,
          uuid: () => ids.shift() ?? "f".repeat(32),
        });
        return {
          expected: { status: "error", final_count: 0 },
          actual: { status: "ok", final_count: paths.length },
        };
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await persistenceMutation(
      "per-image-limit",
      [
        {
          file: "media/persistence.ts",
          from: "if (bytes.byteLength > MAX_IMAGE_BYTES)",
          to: "if (false && bytes.byteLength > MAX_IMAGE_BYTES)",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-item-"));
        try {
          const paths = await media.persistGeneratedImages({
            plan: media.createOutputPlan(join(runtime, "images")),
            payloads: [Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64")],
            requested: 1,
            uuid: () => "a".repeat(32),
          });
          return {
            expected: { status: "error", final_count: 0 },
            actual: { status: "ok", final_count: paths.length },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
        }
      },
    ),
  );

  results.push(
    await persistenceMutation(
      "batch-limit",
      [
        {
          file: "media/persistence.ts",
          from: "if (batchBytes > MAX_IMAGE_BATCH_BYTES)",
          to: "if (false && batchBytes > MAX_IMAGE_BATCH_BYTES)",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-batch-"));
        try {
          const chunk = Buffer.alloc(Math.floor(MAX_IMAGE_BATCH_BYTES / 4) + 1).toString("base64");
          const ids = ["a", "b", "c", "d"].map((value) => value.repeat(32));
          const paths = await media.persistGeneratedImages({
            plan: media.createOutputPlan(join(runtime, "images")),
            payloads: [chunk, chunk, chunk, chunk],
            requested: 4,
            uuid: () => ids.shift() ?? "e".repeat(32),
          });
          return {
            expected: { status: "error", final_count: 0 },
            actual: { status: "ok", final_count: paths.length },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
        }
      },
    ),
  );

  results.push(
    await persistenceMutation(
      "out-dir-symlink",
      [
        {
          file: "media/persistence.ts",
          from: `try {\n    checkControlledRoot(options.plan);\n  } catch {`,
          to: `try {\n    void options.plan;\n  } catch {`,
        },
        {
          file: "media/persistence.ts",
          from: `mkdirSync(options.plan.outDir, { recursive: true });\n  checkControlledRoot(options.plan);`,
          to: `mkdirSync(options.plan.outDir, { recursive: true });\n  void options.plan;`,
        },
        {
          file: "media/persistence.ts",
          from: "    current.isSymbolicLink() ||\n    !current.isDirectory() ||",
          to: "    false ||\n    false ||",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-root-"));
        const external = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-external-"));
        try {
          const outDir = join(runtime, "images");
          let paths: readonly string[] = [];
          let status = "ok";
          try {
            paths = await media.persistGeneratedImages({
              plan: media.createOutputPlan(outDir),
              payloads: ["YQ=="],
              requested: 1,
              uuid: () => "a".repeat(32),
              afterRootPreflight: () => {
                symlinkSync(external, outDir);
              },
            });
          } catch {
            status = "error";
          }
          return {
            expected: { status: "error", external_count: 0 },
            actual: {
              status,
              external_count: readdirSync(external).length,
              returned_count: paths.length,
            },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
          rmSync(external, { recursive: true, force: true });
        }
      },
    ),
  );

  results.push(
    await persistenceMutation(
      "direct-final-write",
      [
        {
          file: "media/persistence.ts",
          from: "const temp = join(options.plan.outDir, `.stage-${randomUUID()}.tmp`);",
          to: "const temp = final;",
        },
        {
          file: "media/persistence.ts",
          from: "cleanupFailures = removeOwnedPaths(owned);",
          to: "void owned;",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-final-"));
        const final = join(runtime, "images", `${"a".repeat(32)}.png`);
        try {
          try {
            await media.persistGeneratedImages({
              plan: media.createOutputPlan(join(runtime, "images")),
              payloads: [Buffer.from("complete-image").toString("base64")],
              requested: 1,
              uuid: () => "a".repeat(32),
              faultAfterBytes: 7,
            });
          } catch {
            // The comparator observes the forbidden final, not the thrown fault.
          }
          return {
            expected: { final_exists: false, final_bytes: 0 },
            actual: {
              final_exists: existsSync(final),
              final_bytes: existsSync(final) ? readFileSync(final).length : 0,
            },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
        }
      },
    ),
  );

  for (const [id, replacement, probe] of [
    [
      "unsafe-url-scheme",
      {
        file: "media/source.ts",
        from: 'if (parsed.protocol !== "http:" && parsed.protocol !== "https:")',
        to: 'if (false && parsed.protocol !== "http:" && parsed.protocol !== "https:")',
      },
      (validate: (value: string) => string) =>
        validate("file:///tmp/CANARY-T21") === "file:///tmp/CANARY-T21",
    ],
    [
      "unsafe-url-loopback",
      {
        file: "media/source.ts",
        from: 'if (unsafeHost(parsed.hostname)) throw new Error("unsafe image host");',
        to: 'if (false && unsafeHost(parsed.hostname)) throw new Error("unsafe image host");',
      },
      (validate: (value: string) => string) =>
        validate("http://127.0.0.1/a") === "http://127.0.0.1/a",
    ],
    [
      "unsafe-data",
      {
        file: "media/source.ts",
        from: 'throw new Error("invalid image base64 payload");',
        to: "bytes = new Uint8Array(0);",
      },
      (validate: (value: string) => string) =>
        validate("data:image/png;base64,%%%") === "data:image/png;base64,%%%",
    ],
  ] as const) {
    const unsafe = await mutantModule(id, "media/source.ts", [replacement]);
    try {
      const validate = unsafe.module["validateRemoteImage"] as (value: string) => string;
      let accepted = false;
      try {
        accepted = probe(validate);
      } catch {
        accepted = false;
      }
      results.push(
        compared(id, { status: "error", runner_calls: 0 }, { status: accepted ? "ok" : "error" }),
      );
    } finally {
      unsafe.dispose();
    }
  }

  const redaction = await mutantModule("redaction", "media/errors.ts", [
    {
      file: "media/errors.ts",
      from: "return `${label}${name}: ${scrub(raw)}`;",
      to: "return raw;",
    },
  ]);
  try {
    const safeMessage = redaction.module["safeMediaMessage"] as (error: unknown) => string;
    const message = safeMessage(
      new Error(
        "https://example.test/a?secret=CANARY-URL data:image/png;base64,CANARYDATA== Bearer CANARY-TOKEN",
      ),
    );
    results.push(
      compared(
        "redaction",
        { url_canary: false, data_canary: false, bearer_canary: false },
        {
          url_canary: message.includes("https://example.test/a?secret=CANARY-URL"),
          data_canary: message.includes("data:image/png;base64,CANARYDATA"),
          bearer_canary: message.includes("Bearer CANARY-TOKEN"),
        },
      ),
    );
  } finally {
    redaction.dispose();
  }

  const redactionNested = await mutantModule("redaction-nested", "media/errors.ts", [
    {
      file: "media/errors.ts",
      from: "return value.map((entry) => safeMediaValue(entry, depth + 1));",
      to: "return value;",
    },
  ]);
  try {
    const safeValue = redactionNested.module["safeMediaValue"] as (value: unknown) => unknown;
    const projected = JSON.stringify(
      safeValue({ items: ["NESTED-CANARY-99", { deep: "DEEP-CANARY-77" }] }),
    );
    results.push(
      compared(
        "redaction-nested",
        { nested_canary: false },
        {
          nested_canary:
            projected.includes("NESTED-CANARY-99") || projected.includes("DEEP-CANARY-77"),
        },
      ),
    );
  } finally {
    redactionNested.dispose();
  }

  results.push(
    await persistenceMutation(
      "hook-after-staging",
      [
        {
          file: "media/persistence.ts",
          from: "  await runPublishHooks(options.plan, finals, rootIdentity, options.beforePublish);",
          to: "  void options.beforePublish;",
        },
        {
          file: "media/persistence.ts",
          from: "        fsyncSync(fd);",
          to: "        await options.beforePublish?.(index, final);\n        fsyncSync(fd);",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-stage-"));
        try {
          const outDir = join(runtime, "images");
          let observedStages = -1;
          await media.persistGeneratedImages({
            plan: media.createOutputPlan(outDir),
            payloads: [Buffer.from("provider").toString("base64")],
            requested: 1,
            uuid: () => "a".repeat(32),
            beforePublish: () => {
              observedStages = readdirSync(outDir).filter((name) =>
                name.startsWith(".stage-"),
              ).length;
            },
          });
          return {
            expected: { stages_visible_to_hook: 0 },
            actual: { stages_visible_to_hook: observedStages },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
        }
      },
    ),
  );

  const child = await mutantModule("child-deny", "tools/child.ts", [
    {
      file: "tools/child.ts",
      from: ".filter((definition) => !excluded.has(definition.function.name))",
      to: ".filter(() => true)",
    },
    {
      file: "tools/child.ts",
      from: `if (excluded.has(name)) {\n      return toolError(\`the '\${name}' tool is not available to subagents\`);\n    }`,
      to: 'if (false && excluded.has(name)) throw new Error("unreachable");',
    },
  ]);
  try {
    let baseCalls = 0;
    const createDispatch = child.module["createChildDispatch"] as (
      base: (name: string) => Promise<string>,
    ) => (name: string, args: unknown) => Promise<string>;
    const dispatch = createDispatch((_name) => {
      baseCalls += 1;
      return Promise.resolve("unsafe");
    });
    await dispatch("image_gen", {});
    results.push(compared("child-deny", { base_calls: 0 }, { base_calls: baseCalls }));
  } finally {
    child.dispose();
  }

  const encoded = await mutantModule("encoded-precheck", "media/source.ts", [
    {
      file: "media/source.ts",
      from: "if (payload.length > MAX_DATA_URI_BASE64_CHARS)",
      to: "if (false && payload.length > MAX_DATA_URI_BASE64_CHARS)",
    },
  ]);
  try {
    let decodeCalls = 0;
    const validate = encoded.module["validateRemoteImage"] as (
      value: string,
      options: { decode(value: string): Uint8Array },
    ) => string;
    try {
      validate(`data:image/png;base64,${"A".repeat(MAX_DATA_URI_BASE64_CHARS + 4)}`, {
        decode: (value) => {
          decodeCalls += 1;
          return Buffer.from(value, "base64");
        },
      });
    } catch {
      // The decoded-size guard may still reject; the forbidden side effect is enough.
    }
    results.push(compared("encoded-precheck", { decode_calls: 0 }, { decode_calls: decodeCalls }));
  } finally {
    encoded.dispose();
  }

  results.push(
    await persistenceMutation(
      "stage-mode",
      [
        {
          file: "media/persistence.ts",
          from: "fchmodSync(fd, IMAGE_FILE_MODE);",
          to: "void IMAGE_FILE_MODE;",
        },
        {
          file: "media/persistence.ts",
          from: "chmodSync(temp, IMAGE_FILE_MODE);",
          to: "void IMAGE_FILE_MODE;",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-mode-"));
        const outDir = join(runtime, "images");
        try {
          const final = join(outDir, `${"a".repeat(32)}.png`);
          let mode = -1;
          let status = "ok";
          try {
            const paths = await media.persistGeneratedImages({
              plan: media.createOutputPlan(outDir),
              payloads: [Buffer.from("provider").toString("base64")],
              requested: 1,
              uuid: () => "a".repeat(32),
            });
            mode = statSync(paths[0] ?? final).mode & 0o777;
          } catch {
            status = "error";
          }
          return {
            expected: { status: "ok", final_mode: 0o644 },
            actual: { status, final_mode: mode },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
        }
      },
    ),
  );

  results.push(
    await persistenceMutation(
      "write-fault-cleanup",
      [
        {
          file: "media/persistence.ts",
          from: "cleanupFailures = removeOwnedPaths(owned);",
          to: "void owned;",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-owned-"));
        const outDir = join(runtime, "images");
        try {
          let status = "ok";
          try {
            await media.persistGeneratedImages({
              plan: media.createOutputPlan(outDir),
              payloads: [Buffer.from("provider").toString("base64")],
              requested: 1,
              uuid: () => "a".repeat(32),
              faultAfterBytes: 7,
            });
          } catch {
            status = "error";
          }
          const residue = readdirSync(outDir).filter((name) => name.startsWith(".stage-")).length;
          return {
            expected: { status: "error", residue: 0 },
            actual: { status, residue },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
        }
      },
    ),
  );

  results.push(
    await persistenceMutation(
      "root-identity",
      [
        {
          file: "media/persistence.ts",
          from: 'throw new Error("output root changed after publish hook");',
          to: "void 0;",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-rootid-"));
        try {
          const outDir = join(runtime, "images");
          const moved = join(runtime, "moved");
          const payload = Buffer.from("PRIVATE-PROVIDER-BYTES");
          let errorName = "none";
          try {
            await media.persistGeneratedImages({
              plan: media.createOutputPlan(outDir),
              payloads: [payload.toString("base64")],
              requested: 1,
              uuid: () => "d".repeat(32),
              beforePublish: () => {
                renameSync(outDir, moved);
                mkdirSync(outDir);
              },
            });
          } catch (error) {
            errorName = error instanceof Error ? error.message : String(error);
          }
          return {
            expected: {
              status: "error",
              error_named: "output root changed after publish hook",
              final_count: 0,
            },
            actual: {
              status: "error",
              error_named: errorName,
              final_count: existsSync(join(outDir, `${"d".repeat(32)}.png`)) ? 1 : 0,
            },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
        }
      },
    ),
  );

  results.push(
    await persistenceMutation(
      "publish-hook-omitted",
      [
        {
          file: "media/persistence.ts",
          from: "  await runPublishHooks(options.plan, finals, rootIdentity, options.beforePublish);",
          to: "  void options.beforePublish;",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-reloc-"));
        try {
          const outDir = join(runtime, "images");
          const moved = join(runtime, "moved");
          let status = "ok";
          try {
            await media.persistGeneratedImages({
              plan: media.createOutputPlan(outDir),
              payloads: [Buffer.from("PRIVATE-PROVIDER-BYTES").toString("base64")],
              requested: 1,
              uuid: () => "d".repeat(32),
              beforePublish: () => {
                renameSync(outDir, moved);
                mkdirSync(outDir);
              },
            });
          } catch {
            status = "error";
          }
          return {
            expected: { status: "error", hook_ran: true },
            actual: {
              status,
              hook_ran: existsSync(moved),
            },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
        }
      },
    ),
  );

  results.push(
    await persistenceMutation(
      "root-check-before-hook",
      [
        {
          file: "media/persistence.ts",
          from: "    await hook?.(index, final);\n    assertRootIdentity(plan, rootIdentity);",
          to: "    assertRootIdentity(plan, rootIdentity);\n    await hook?.(index, final);",
        },
        {
          file: "media/persistence.ts",
          from: "      assertRootIdentity(options.plan, rootIdentity);",
          to: "      void rootIdentity;",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-check-order-"));
        try {
          const outDir = join(runtime, "images");
          const moved = join(runtime, "moved");
          let status = "ok";
          try {
            await media.persistGeneratedImages({
              plan: media.createOutputPlan(outDir),
              payloads: [Buffer.from("PRIVATE-PROVIDER-BYTES").toString("base64")],
              requested: 1,
              uuid: () => "d".repeat(32),
              beforePublish: () => {
                renameSync(outDir, moved);
                mkdirSync(outDir);
              },
            });
          } catch {
            status = "error";
          }
          return {
            expected: { status: "error", final_count: 0 },
            actual: {
              status,
              final_count: readdirSync(outDir).filter((name) => name.endsWith(".png")).length,
            },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
        }
      },
    ),
  );

  results.push(
    await persistenceMutation(
      "root-symlink-after-check",
      [
        {
          file: "media/persistence.ts",
          from: "    await hook?.(index, final);\n    assertRootIdentity(plan, rootIdentity);",
          to: "    assertRootIdentity(plan, rootIdentity);\n    await hook?.(index, final);",
        },
        {
          file: "media/persistence.ts",
          from: "      assertRootIdentity(options.plan, rootIdentity);",
          to: "      void rootIdentity;",
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-rootlink-"));
        const external = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-rootlink-external-"));
        try {
          const outDir = join(runtime, "images");
          const moved = join(runtime, "moved");
          let status = "ok";
          try {
            await media.persistGeneratedImages({
              plan: media.createOutputPlan(outDir),
              payloads: [Buffer.from("PRIVATE-PROVIDER-BYTES").toString("base64")],
              requested: 1,
              uuid: () => "d".repeat(32),
              beforePublish: () => {
                renameSync(outDir, moved);
                symlinkSync(external, outDir);
              },
            });
          } catch {
            status = "error";
          }
          return {
            expected: { status: "error", external_payloads: 0 },
            actual: {
              status,
              external_payloads: readdirSync(external).filter((name) => name.endsWith(".png"))
                .length,
            },
          };
        } finally {
          rmSync(runtime, { recursive: true, force: true });
          rmSync(external, { recursive: true, force: true });
        }
      },
    ),
  );

  const atomicRename = await mutantModule("atomic-rename-primitive", "media/persistence.ts", [
    {
      file: "media/persistence.ts",
      from: "  renameSync,\n  rmSync,",
      to: "  linkSync,\n  rmSync,",
    },
    {
      file: "media/persistence.ts",
      from: "      renameSync(temp, final);",
      to: "      linkSync(temp, final);\n      rmSync(temp);",
    },
  ]);
  try {
    const implementation = String(atomicRename.module["persistGeneratedImages"]);
    results.push(
      compared(
        "atomic-rename-primitive",
        { primitive: "rename" },
        { primitive: implementation.includes("renameSync(temp, final)") ? "rename" : "other" },
      ),
    );
  } finally {
    atomicRename.dispose();
  }
  return Object.freeze(results);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1])) {
  const results = await runMutations();
  const failures = results.filter((result) => !result.killed).length;
  process.stdout.write(`${JSON.stringify({ suite: "t21-mutations", results, failures })}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}
