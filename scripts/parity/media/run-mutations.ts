#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
          from: `await options.beforePublish?.(index, final);\n      checkControlledRoot(options.plan);`,
          to: `await options.beforePublish?.(index, final);\n      void options.plan;`,
        },
      ],
      async (media) => {
        const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-root-"));
        const external = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-external-"));
        try {
          const outDir = join(runtime, "images");
          const paths = await media.persistGeneratedImages({
            plan: media.createOutputPlan(outDir),
            payloads: ["YQ=="],
            requested: 1,
            uuid: () => "a".repeat(32),
            afterRootPreflight: () => {
              symlinkSync(external, outDir);
            },
          });
          return {
            expected: { status: "error", external_count: 0 },
            actual: {
              status: "ok",
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
          from: "for (const path of [...temps, ...published]) {",
          to: "for (const path of [] as string[]) {",
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
              writeStage: (fd: number, bytes: Buffer) => {
                writeFileSync(fd, bytes.subarray(0, 7));
                throw new Error("fault after seven bytes");
              },
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

  const unsafe = await mutantModule("unsafe-url", "media/source.ts", [
    {
      file: "media/source.ts",
      from: 'if (unsafeHost(parsed.hostname)) throw new Error("unsafe image host");',
      to: 'if (false && unsafeHost(parsed.hostname)) throw new Error("unsafe image host");',
    },
  ]);
  try {
    const validate = unsafe.module["validateRemoteImage"] as (value: string) => string;
    results.push(
      compared(
        "unsafe-url",
        { status: "error", runner_calls: 0 },
        {
          status: validate("http://localhost./a") === "http://localhost./a" ? "ok" : "error",
          runner_calls: 1,
        },
      ),
    );
  } finally {
    unsafe.dispose();
  }

  const redaction = await mutantModule("redaction", "media/errors.ts", [
    {
      file: "media/errors.ts",
      from: "return `${label}${name}: ${clean}`;",
      to: "return raw;",
    },
  ]);
  try {
    const safeMessage = redaction.module["safeMediaMessage"] as (error: unknown) => string;
    const message = safeMessage(new Error("https://example.test/a?secret=CANARY-T21"));
    results.push(
      compared("redaction", { raw_canary: false }, { raw_canary: message.includes("CANARY-T21") }),
    );
  } finally {
    redaction.dispose();
  }

  const child = await mutantModule("child-deny", "tools/child.ts", [
    {
      file: "tools/child.ts",
      from: ".filter((definition) => allowed.has(definition.function.name))",
      to: ".filter(() => true)",
    },
    {
      file: "tools/child.ts",
      from: `if (excluded.has(name)) {\n      return toolError(\`the '\${name}' tool is not available to subagents\`);\n    }`,
      to: 'if (false && excluded.has(name)) throw new Error("unreachable");',
    },
    {
      file: "tools/child.ts",
      from: "if (!allowed.has(name)) return toolError(`Unknown tool: ${name}`);",
      to: "if (false && !allowed.has(name)) return toolError(`Unknown tool: ${name}`);",
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
    compared("unclassified-functional-difference", { result: { n: 1 } }, { result: { n: 2 } }),
  );
  return Object.freeze(results);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1])) {
  const results = await runMutations();
  const failures = results.filter((result) => !result.killed).length;
  process.stdout.write(`${JSON.stringify({ suite: "t21-mutations", results, failures })}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}
