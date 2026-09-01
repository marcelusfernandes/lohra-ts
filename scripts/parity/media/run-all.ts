#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import type { ModelRequest, ModelTransport } from "../../../src/conversation/types.js";
import type { ImageGenerationPort, ImageGenerationRequest } from "../../../src/media/types.js";
import type { NormalizedResponse } from "../../../src/transports/index.js";
import { canonicalJson } from "../canonical.js";
import { compareMediaRows, type DivergenceSpec, type MediaRow } from "./comparator.js";
import { installNetworkSentinel } from "./network-sentinel.mjs";

const root = resolve(import.meta.dirname, "../../..");
const pythonWorkspace =
  process.env["LOHRA_ORACLE_WORKSPACE"] ?? join(homedir(), "Desktop/playground-ai/lohra-ts");
const oracleCheckout = join(pythonWorkspace, "lohra");
const oraclePython = join(pythonWorkspace, ".oracle-venv/bin/python");
const oracleLohra = join(pythonWorkspace, ".oracle-venv/bin/lohra");
const oracleDriver = resolve(import.meta.dirname, "oracle_driver.py");
const evidenceRoot = resolve(root, ".parity-evidence/t21");
const evidencePath = resolve(evidenceRoot, "media-parity.json");

function command(executable: string, argv: readonly string[], cwd = root): string {
  const result = spawnSync(executable, argv, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
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

class VisionCapture implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(request);
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
  readonly requests: ImageGenerationRequest[] = [];
  constructor(private readonly payloads: readonly string[]) {}
  generate(request: ImageGenerationRequest): Promise<readonly string[]> {
    this.requests.push(request);
    return Promise.resolve(this.payloads);
  }
}

function projectUrl(value: string): Record<string, unknown> {
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    const header = value.slice(5, comma).replace(/;base64$/, "");
    const payload = comma < 0 ? "" : value.slice(comma + 1);
    const bytes = Buffer.from(payload, "base64");
    const valid = payload.length > 0 && bytes.toString("base64") === payload;
    return {
      kind: "data",
      mime: header,
      length: value.length,
      encoded_length: payload.length,
      decoded_bytes: valid ? bytes.length : 0,
      valid_base64: valid,
      sha256: valid ? sha(bytes) : null,
    };
  }
  let scheme: string | null;
  let hasUserinfo = false;
  try {
    const parsed = new URL(value);
    scheme = parsed.protocol.slice(0, -1);
    hasUserinfo = parsed.username !== "" || parsed.password !== "";
  } catch {
    scheme = value.includes(":") ? (value.split(":", 1)[0] ?? null) : null;
  }
  return {
    kind: "url",
    scheme,
    length: value.length,
    sha256: sha(value),
    has_query: value.includes("?"),
    has_userinfo: hasUserinfo,
  };
}

const sentinelProof = installNetworkSentinel();
try {
  await fetch("https://network-sentinel.invalid/");
  throw new Error("T21_NETWORK_SENTINEL_DID_NOT_BLOCK");
} catch (error) {
  if (!(error instanceof Error) || error.message !== "NETWORK_DISABLED") throw error;
}
if (sentinelProof.attempts() !== 1) throw new Error("T21_NETWORK_SENTINEL_COUNTER");
sentinelProof.restore();
const network = installNetworkSentinel();
const media = await import("../../../src/media/index.js");
const { runMutations } = await import("./run-mutations.js");

async function visionCase(id: string, url: string, prompt: unknown = "x"): Promise<MediaRow> {
  const runner = new VisionCapture();
  const directory = mkdtempSync(join(tmpdir(), "lohra-t21-vision-case-"));
  try {
    const envelope = JSON.parse(
      await media.createVisionAnalyzeHandler({ runner, model: "m", localRoot: directory })({
        url,
        prompt,
      }),
    ) as Record<string, unknown>;
    if ("error" in envelope)
      return { id, value: { status: "error", runner_calls: runner.requests.length } };
    const content = runner.requests[0]?.messages[0]?.["content"] as
      Array<{ text?: unknown; image_url?: { url?: string } }> | undefined;
    return {
      id,
      value: {
        status: "ok",
        runner_calls: runner.requests.length,
        result: envelope,
        prompt: content?.[0],
        source: projectUrl(content?.[1]?.image_url?.url ?? ""),
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function imageCase(
  id: string,
  args: Readonly<Record<string, unknown>>,
  returned = 0,
): Promise<MediaRow> {
  const directory = mkdtempSync(join(tmpdir(), "lohra-t21-image-case-"));
  try {
    const generator = new ImageCapture(
      Array.from({ length: returned }, () => Buffer.from("PNG-T21").toString("base64")),
    );
    const ids = Array.from({ length: Math.max(1, returned) }, (_, index) =>
      index.toString(16).padStart(32, "0"),
    );
    const envelope = JSON.parse(
      await media.createImageGenHandler({
        generator,
        outDir: join(directory, "images"),
        uuid: () => ids.shift() ?? "f".repeat(32),
      })(args),
    ) as Record<string, unknown>;
    if ("error" in envelope)
      return { id, value: { status: "error", runner_calls: generator.requests.length } };
    const request = generator.requests[0];
    const images = Array.isArray(envelope["images"]) ? envelope["images"] : [];
    const files = images.map((path) => {
      const bytes = readFileSync(String(path));
      return {
        bytes: bytes.length,
        mode: statSync(String(path)).mode & 0o777,
        sha256: sha(bytes),
      };
    });
    return {
      id,
      value: {
        status: "ok",
        runner_calls: generator.requests.length,
        request:
          request === undefined
            ? null
            : { prompt: request.prompt, size: request.size ?? null, n: request.n },
        result: { ok: envelope["ok"] === true, image_count: images.length },
        files,
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function candidateRows(): Promise<readonly MediaRow[]> {
  const directory = mkdtempSync(join(tmpdir(), "lohra-t21-candidate-"));
  try {
    const image = join(directory, "one.png");
    writeFileSync(image, "PNG-T21");
    const local = await media.buildImagePart({ path: image, localRoot: directory });
    const dataValid = `data:image/png;base64,${Buffer.from("PNG-T21").toString("base64")}`;
    return [
      { id: "vision.text-part", value: media.textPart("x") },
      { id: "vision.local-part", value: projectUrl(local.image_url.url) },
      await visionCase("vision.https", "https://example.test/a?sig=CANARY-T21", "   "),
      await visionCase("vision.http", "http://example.test/a"),
      await visionCase("vision.data-valid", dataValid),
      await visionCase("vision.http-oversize", `https://example.test/${"a".repeat(16_384)}`),
      await visionCase("vision.credentials", "https://u:p@example.test/a"),
      await visionCase("vision.malformed", "not a url"),
      await visionCase("vision.file-scheme", "file:///tmp/CANARY-T21"),
      await visionCase("vision.javascript", "javascript:alert(1)"),
      await visionCase("vision.localhost-dot", "http://localhost./a"),
      await visionCase("vision.private-ip", "http://127.0.0.1/a"),
      await visionCase("vision.reserved-ipv6", "http://[ff02::1]/a"),
      await visionCase("vision.data-non-image", "data:text/plain;base64,QQ=="),
      await visionCase("vision.data-invalid", "data:image/png;base64,%%%"),
      await visionCase("vision.data-oversize", `data:image/png;base64,${"A".repeat(27_962_032)}`),
      await imageCase("image.main", { prompt: [1, "x"], n: "2", size: "512x512" }, 1),
      await imageCase("image.prompt-true", { prompt: true }),
      await imageCase("image.prompt-object", { prompt: { a: 1 } }),
      await imageCase("image.prompt-blank", { prompt: "   " }),
      await imageCase("image.n-string", { prompt: "x", n: "2" }),
      await imageCase("image.n-float", { prompt: "x", n: 1.9 }),
      await imageCase("image.n-invalid", { prompt: "x", n: "1.9" }),
      await imageCase("image.n-clamp", { prompt: "x", n: 50 }),
      await imageCase("image.size-invalid", { prompt: "x", size: "512x512" }),
      await imageCase("image.over-return-12", { prompt: "x", n: 1 }, 12),
    ];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const divergence = (
  classification: DivergenceSpec["classification"],
  runnerCalls: number,
): DivergenceSpec => ({
  classification,
  candidate: { status: "error", runner_calls: runnerCalls },
});
const divergences: Readonly<Record<string, DivergenceSpec>> = Object.freeze({
  "vision.http-oversize": divergence("intentional-divergence/bounded", 0),
  "vision.credentials": divergence("intentional-divergence/privacy", 0),
  "vision.malformed": divergence("intentional-divergence/validation", 0),
  "vision.file-scheme": divergence("intentional-divergence/validation", 0),
  "vision.javascript": divergence("intentional-divergence/validation", 0),
  "vision.localhost-dot": divergence("intentional-divergence/privacy", 0),
  "vision.private-ip": divergence("intentional-divergence/privacy", 0),
  "vision.reserved-ipv6": divergence("intentional-divergence/privacy", 0),
  "vision.data-non-image": divergence("intentional-divergence/validation", 0),
  "vision.data-invalid": divergence("intentional-divergence/validation", 0),
  "vision.data-oversize": divergence("intentional-divergence/bounded", 0),
  "image.over-return-12": divergence("intentional-divergence/bounded", 1),
});

const oracleCommit = command("/usr/bin/git", ["rev-parse", "HEAD"], oracleCheckout).trim();
if (oracleCommit !== "16b4785d803ad0ca364a8a67346a04f949fbf592")
  throw new Error(`T21_ORACLE_PIN:${oracleCommit}`);
if (command("/usr/bin/git", ["status", "--porcelain"], oracleCheckout) !== "")
  throw new Error("T21_ORACLE_DIRTY");
if (command(oracleLohra, ["--version"], oracleCheckout) !== "lohra 0.0.11\n")
  throw new Error("T21_ORACLE_VERSION");

type DriverResult = { readonly rows: readonly MediaRow[]; readonly network_attempts: number };
const oracleFirst = JSON.parse(
  command(oraclePython, [oracleDriver], oracleCheckout),
) as DriverResult;
const oracleSecond = JSON.parse(
  command(oraclePython, [oracleDriver], oracleCheckout),
) as DriverResult;
const candidateFirst = await candidateRows();
const candidateSecond = await candidateRows();
if (canonicalJson(oracleFirst) !== canonicalJson(oracleSecond))
  throw new Error("T21_ORACLE_NONDETERMINISTIC");
if (canonicalJson(candidateFirst) !== canonicalJson(candidateSecond))
  throw new Error("T21_CANDIDATE_NONDETERMINISTIC");
const comparisons = compareMediaRows(oracleFirst.rows, candidateFirst, divergences);
const mutations = await runMutations();
if (command("/usr/bin/git", ["status", "--porcelain"], oracleCheckout) !== "")
  throw new Error("T21_ORACLE_DIRTY_AFTER");

const comparisonFailures = comparisons.filter((entry) => !entry.pass).length;
const mutationFailures = mutations.filter((entry) => !entry.killed).length;
const networkAttempts = oracleFirst.network_attempts + network.attempts();
const failures = comparisonFailures + mutationFailures + networkAttempts;
const evidence = {
  schema_version: 2,
  suite: "t21-media",
  oracle: { commit: oracleCommit, version: "lohra 0.0.11" },
  candidate: { commit: command("/usr/bin/git", ["rev-parse", "HEAD"]).trim() },
  comparisons,
  mutations,
  toctou_limitation: media.MEDIA_TOCTOU_LIMITATION,
  integration_gate: "integration_unavailable",
  live_smoke: { status: "not_authorized", provider: null, requests: 0 },
  network_sentinel_self_test: "blocked-before-media-import",
  network_attempts: networkAttempts,
  failures,
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
  `${JSON.stringify({ suite: "t21-media", evidence: evidencePath, sha256: sha(serialized), scenarios: comparisons.length, mutants: mutations.length, network_attempts: networkAttempts, failures })}\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
