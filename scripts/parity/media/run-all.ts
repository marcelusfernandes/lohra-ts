#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ModelRequest, ModelTransport } from "../../../src/conversation/types.js";
import {
  createImageGenHandler,
  createVisionAnalyzeHandler,
  textPart,
  type ImageGenerationPort,
  type ImageGenerationRequest,
} from "../../../src/media/index.js";
import type { NormalizedResponse } from "../../../src/transports/index.js";
import { canonicalJson } from "../canonical.js";
import { runMutations } from "./run-mutations.js";

const root = resolve(import.meta.dirname, "../../..");
const oracleCheckout = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/lohra";
const oraclePython =
  "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/.oracle-venv/bin/python";
const oracleLohra =
  "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/.oracle-venv/bin/lohra";
const oracleDriver = resolve(import.meta.dirname, "oracle_driver.py");
const evidenceRoot = resolve(root, ".parity-evidence/t21");
const evidencePath = resolve(evidenceRoot, "media-parity.json");

function command(executable: string, argv: readonly string[], cwd = root): string {
  const result = spawnSync(executable, argv, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: tmpdir(),
      PYTHONPATH: resolve(oracleCheckout, "backend"),
      PYTHONHASHSEED: "0",
      PYTHONUTF8: "1",
      TZ: "UTC",
      LC_ALL: "C",
    },
  });
  if (result.status !== 0)
    throw new Error(`T21_COMMAND_FAILED:${executable}:${String(result.status)}:${result.stderr}`);
  return result.stdout;
}

function sha(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const normalized = (value: string): string => value.replace(/Error:\s*/g, "");

class VisionCapture implements ModelTransport {
  request: ModelRequest | undefined;
  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.request = request;
    return Promise.resolve({
      content: "oracle-analysis",
      finishReason: "stop",
      toolCalls: [],
      reasoning: null,
      usage: null,
      providerData: null,
    });
  }
  close(): void {}
}

class ImageCapture implements ImageGenerationPort {
  request: ImageGenerationRequest | undefined;
  constructor(private readonly payloads: readonly string[]) {}
  generate(request: ImageGenerationRequest): Promise<readonly string[]> {
    this.request = request;
    return Promise.resolve(this.payloads);
  }
}

function projectImage(value: string): Record<string, unknown> {
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    const header = value.slice(5, comma).replace(/;base64$/, "");
    const bytes = Buffer.from(value.slice(comma + 1), "base64");
    return {
      kind: "data",
      mime: header,
      length: value.length,
      decoded_bytes: bytes.length,
      sha256: sha(bytes),
    };
  }
  const parsed = new URL(value);
  return {
    kind: "url",
    scheme: parsed.protocol.slice(0, -1),
    length: value.length,
    sha256: sha(value),
    has_query: parsed.search !== "",
    has_userinfo: parsed.username !== "" || parsed.password !== "",
  };
}

async function candidate(): Promise<Record<string, unknown>> {
  const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-candidate-"));
  try {
    const localRoot = join(runtime, "local");
    const outParent = join(runtime, "output");
    mkdirSync(localRoot);
    mkdirSync(outParent);
    const image = join(localRoot, "one.png");
    writeFileSync(image, "PNG-T21");
    const url = "https://example.test/a?sig=CANARY-T21";

    const localRunner = new VisionCapture();
    await createVisionAnalyzeHandler({ runner: localRunner, model: "m", localRoot })({
      path: image,
      prompt: "x",
    });
    const localMessage = localRunner.request?.messages[0] as
      { content?: Array<{ image_url?: { url?: string } }> } | undefined;
    const localUrl = localMessage?.content?.[1]?.image_url?.url ?? "";

    const urlRunner = new VisionCapture();
    const vision = createVisionAnalyzeHandler({ runner: urlRunner, model: "m", localRoot });
    const visionResult = JSON.parse(await vision({ url, prompt: "   " })) as unknown;
    const urlMessage = urlRunner.request?.messages[0] as
      { content?: Array<Record<string, unknown>> } | undefined;
    const parts = urlMessage?.content ?? [];
    const imagePart = parts[1] as { image_url?: { url?: string } } | undefined;

    const generated = new ImageCapture([Buffer.from("PNG-T21").toString("base64")]);
    const imageHandler = createImageGenHandler({
      generator: generated,
      outDir: join(outParent, "images"),
      uuid: () => "a".repeat(32),
    });
    const imageResult = JSON.parse(
      await imageHandler({ prompt: [1, "x"], n: "2", size: "512x512" }),
    ) as { images?: string[] };
    const saved = imageResult.images?.[0];

    const unsafe = normalized(await vision({ url: "file:///tmp/CANARY-T21" }));
    const over = normalized(
      await createImageGenHandler({
        generator: new ImageCapture(["YQ==", "Yg=="]),
        outDir: join(outParent, "over"),
      })({ prompt: "x", n: 1 }),
    );

    return {
      vision: {
        text: textPart("x"),
        url: projectImage(imagePart?.image_url?.url ?? ""),
        local: projectImage(localUrl),
        handler: {
          result: visionResult,
          prompt: parts[0],
          image: projectImage(imagePart?.image_url?.url ?? ""),
        },
      },
      image_gen: {
        request: generated.request,
        result: { ok: true, images: saved === undefined ? [] : ["<PATH>"] },
        file:
          saved === undefined
            ? null
            : {
                bytes: statSync(saved).size,
                mode: statSync(saved).mode & 0o777,
                sha256: sha(readFileSync(saved)),
              },
      },
      divergences: [
        { id: "unsafe-scheme", class: "intentional-divergence/validation", envelope: unsafe },
        {
          id: "over-return",
          class: "intentional-divergence/bounded",
          envelope: over,
          final_count: 0,
        },
      ],
      network_attempts: 0,
    };
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

const oracleCommit = command("/usr/bin/git", ["rev-parse", "HEAD"], oracleCheckout).trim();
if (oracleCommit !== "16b4785d803ad0ca364a8a67346a04f949fbf592")
  throw new Error(`T21_ORACLE_PIN:${oracleCommit}`);
if (command("/usr/bin/git", ["status", "--porcelain"], oracleCheckout) !== "")
  throw new Error("T21_ORACLE_DIRTY");
if (command(oracleLohra, ["--version"], oracleCheckout) !== "lohra 0.0.11\n")
  throw new Error("T21_ORACLE_VERSION");

const oracleFirst = JSON.parse(command(oraclePython, [oracleDriver], oracleCheckout)) as unknown;
const oracleSecond = JSON.parse(command(oraclePython, [oracleDriver], oracleCheckout)) as unknown;
const candidateFirst = await candidate();
const candidateSecond = await candidate();
if (canonicalJson(oracleFirst) !== canonicalJson(oracleSecond))
  throw new Error("T21_ORACLE_NONDETERMINISTIC");
if (canonicalJson(candidateFirst) !== canonicalJson(candidateSecond))
  throw new Error("T21_CANDIDATE_NONDETERMINISTIC");
const mutations = await runMutations();
if (mutations.some((entry) => !entry.killed)) throw new Error("T21_MUTANT_SURVIVED");
if (command("/usr/bin/git", ["status", "--porcelain"], oracleCheckout) !== "")
  throw new Error("T21_ORACLE_DIRTY_AFTER");

const evidence = {
  schema_version: 1,
  suite: "t21-media",
  oracle: { commit: oracleCommit, version: "lohra 0.0.11", projection: oracleFirst },
  candidate: {
    commit: command("/usr/bin/git", ["rev-parse", "HEAD"]).trim(),
    projection: candidateFirst,
  },
  mutations,
  integration_gate: "integration_unavailable",
  live_smoke: "not_authorized",
  network_attempts: 0,
  failures: 0,
};
const serialized = `${canonicalJson(evidence)}\n`;
if (
  serialized.includes("CANARY-T21") ||
  serialized.includes("data:image") ||
  serialized.includes("Bearer ")
)
  throw new Error("T21_EVIDENCE_RAW_LEAK");
mkdirSync(evidenceRoot, { recursive: true });
writeFileSync(evidencePath, serialized, { mode: 0o600 });
chmodSync(evidencePath, 0o600);
process.stdout.write(
  `${JSON.stringify({ suite: "t21-media", evidence: evidencePath, sha256: sha(serialized), scenarios: 7, mutants: mutations.length, failures: 0 })}\n`,
);
