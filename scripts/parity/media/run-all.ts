#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import dns from "node:dns";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function scrubMessage(value: string, tmpRoot: string): string {
  const canonical = realpathSync(tmpRoot);
  return value
    .replace(/data:[^\s]+/g, "<redacted-data-uri>")
    .replace(/https?:\/\/[^\s]+/g, "<redacted-url>")
    .replaceAll("CANARY-T21", "<redacted-canary>")
    .replaceAll(tmpRoot, "<TMP>")
    .replaceAll(canonical, "<TMP>");
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
// The self-test must cover a resolver family that bypasses net/dgram entirely.
try {
  void dns.promises.resolve4("network-sentinel.invalid");
  throw new Error("T21_NETWORK_SENTINEL_DID_NOT_BLOCK");
} catch (error) {
  if (!(error instanceof Error) || error.message !== "NETWORK_DISABLED") throw error;
}
if (sentinelProof.attempts() !== 2) throw new Error("T21_NETWORK_SENTINEL_COUNTER");
sentinelProof.restore();
const network = installNetworkSentinel();
const media = await import("../../../src/media/index.js");
const { runMutations } = await import("./run-mutations.js");

async function visionCase(
  id: string,
  source: { url?: string; path?: string },
  prompt: unknown = "x",
  localRoot?: string,
): Promise<MediaRow> {
  const runner = new VisionCapture();
  const directory = mkdtempSync(join(tmpdir(), "lohra-t21-vision-case-"));
  try {
    const envelope = JSON.parse(
      await media.createVisionAnalyzeHandler({
        runner,
        model: "m",
        localRoot: localRoot ?? directory,
      })({ ...source, prompt }),
    ) as Record<string, unknown>;
    if ("error" in envelope)
      return {
        id,
        value: {
          status: "error",
          runner_calls: runner.requests.length,
          error: scrubMessage(String(envelope["error"]), localRoot ?? directory),
        },
      };
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
  trackFinals = false,
): Promise<MediaRow> {
  const directory = mkdtempSync(join(tmpdir(), "lohra-t21-image-case-"));
  const imagesDir = join(directory, "images");
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
        outDir: imagesDir,
        uuid: () => ids.shift() ?? "f".repeat(32),
      })(args),
    ) as Record<string, unknown>;
    if ("error" in envelope)
      return {
        id,
        value: {
          status: "error",
          runner_calls: generator.requests.length,
          ...(trackFinals
            ? { final_count: existsSync(imagesDir) ? readdirSync(imagesDir).length : 0 }
            : {}),
          error: scrubMessage(String(envelope["error"]), directory),
        },
      };
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
  const outsidePath = join(dirname(directory), "outside.png");
  const secret = join(directory, "secret.png");
  writeFileSync(outsidePath, "PNG-T21");
  try {
    const image = join(directory, "one.png");
    writeFileSync(image, "PNG-T21");
    const jpg = join(directory, "photo.jpg");
    writeFileSync(jpg, "PNG-T21");
    const noext = join(directory, "noext");
    writeFileSync(noext, "PNG-T21");
    const svg = join(directory, "vector.svg");
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const txt = join(directory, "notes.txt");
    writeFileSync(txt, "hello");
    writeFileSync(secret, "PNG-T21");
    chmodSync(secret, 0o000);
    const link = join(directory, "link.png");
    symlinkSync(image, link);
    const local = await media.buildImagePart({ path: image, localRoot: directory });
    const dataValid = `data:image/png;base64,${Buffer.from("PNG-T21").toString("base64")}`;
    return [
      { id: "vision.text-part", value: media.textPart("x") },
      { id: "vision.local-part", value: projectUrl(local.image_url.url) },
      await visionCase("vision.local-jpg", { path: jpg }, "x", directory),
      await visionCase("vision.local-noext", { path: noext }, "x", directory),
      await visionCase("vision.local-svg", { path: svg }, "x", directory),
      await visionCase("vision.local-txt", { path: txt }, "x", directory),
      await visionCase(
        "vision.local-missing",
        { path: join(directory, "missing.png") },
        "x",
        directory,
      ),
      await visionCase("vision.local-traversal", { path: outsidePath }, "x", directory),
      await visionCase("vision.local-symlink", { path: link }, "x", directory),
      await visionCase("vision.local-read-fault", { path: secret }, "x", directory),
      await visionCase("vision.https", { url: "https://example.test/a?sig=CANARY-T21" }, "   "),
      await visionCase("vision.http", { url: "http://example.test/a" }),
      await visionCase("vision.data-valid", { url: dataValid }),
      await visionCase("vision.http-oversize", {
        url: `https://example.test/${"a".repeat(16_384)}`,
      }),
      await visionCase("vision.credentials", { url: "https://u:p@example.test/a" }),
      await visionCase("vision.malformed", { url: "not a url" }),
      await visionCase("vision.file-scheme", { url: "file:///tmp/CANARY-T21" }),
      await visionCase("vision.javascript", { url: "javascript:alert(1)" }),
      await visionCase("vision.localhost-dot", { url: "http://localhost./a" }),
      await visionCase("vision.private-ip", { url: "http://127.0.0.1/a" }),
      await visionCase("vision.reserved-ipv6", { url: "http://[ff02::1]/a" }),
      await visionCase("vision.data-non-image", { url: "data:text/plain;base64,QQ==" }),
      await visionCase("vision.data-invalid", { url: "data:image/png;base64,%%%" }),
      await visionCase("vision.data-oversize", {
        url: `data:image/png;base64,${"A".repeat(27_962_032)}`,
      }),
      await imageCase("image.main", { prompt: [1, "x"], n: "2", size: "512x512" }, 1),
      await imageCase("image.prompt-true", { prompt: true }),
      await imageCase("image.prompt-object", { prompt: { a: 1 } }),
      await imageCase("image.prompt-blank", { prompt: "   " }),
      await imageCase("image.n-string", { prompt: "x", n: "2" }),
      await imageCase("image.n-float", { prompt: "x", n: 1.9 }),
      await imageCase("image.n-invalid", { prompt: "x", n: "1.9" }),
      await imageCase("image.n-clamp", { prompt: "x", n: 50 }),
      await imageCase("image.size-invalid", { prompt: "x", size: "512x512" }),
      await imageCase("image.over-return-12", { prompt: "x", n: 1 }, 12, true),
    ];
  } finally {
    rmSync(outsidePath, { force: true });
    chmodSync(secret, 0o644);
    rmSync(directory, { recursive: true, force: true });
  }
}

const divergence = (
  classification: DivergenceSpec["classification"],
  candidate: unknown,
  candidateErrorIncludes?: readonly string[],
  oracleErrorIncludes?: readonly string[],
): DivergenceSpec => ({
  classification,
  candidate,
  ...(candidateErrorIncludes === undefined ? {} : { candidateErrorIncludes }),
  ...(oracleErrorIncludes === undefined ? {} : { oracleErrorIncludes }),
});
const candidateError = (runnerCalls: number, finalCount?: number): Record<string, unknown> => ({
  status: "error",
  runner_calls: runnerCalls,
  ...(finalCount === undefined ? {} : { final_count: finalCount }),
});
const divergences: Readonly<Record<string, DivergenceSpec>> = Object.freeze({
  "vision.http-oversize": divergence("intentional-divergence/bounded", candidateError(0), [
    "too long",
  ]),
  "vision.credentials": divergence("intentional-divergence/privacy", candidateError(0), [
    "credentials",
  ]),
  "vision.malformed": divergence("intentional-divergence/validation", candidateError(0), [
    "unsupported image URL",
  ]),
  "vision.file-scheme": divergence("intentional-divergence/validation", candidateError(0), [
    "unsupported image URL",
  ]),
  "vision.javascript": divergence("intentional-divergence/validation", candidateError(0), [
    "unsupported image URL",
  ]),
  "vision.localhost-dot": divergence("intentional-divergence/privacy", candidateError(0), [
    "unsafe image host",
  ]),
  "vision.private-ip": divergence("intentional-divergence/privacy", candidateError(0), [
    "unsafe image host",
  ]),
  "vision.reserved-ipv6": divergence("intentional-divergence/privacy", candidateError(0), [
    "unsafe image host",
  ]),
  "vision.data-non-image": divergence("intentional-divergence/validation", candidateError(0), [
    "expected an image data URI",
  ]),
  "vision.data-invalid": divergence("intentional-divergence/validation", candidateError(0), [
    "invalid image base64 payload",
  ]),
  "vision.data-oversize": divergence("intentional-divergence/bounded", candidateError(0), [
    "too large",
  ]),
  "vision.local-traversal": divergence("intentional-divergence/privacy", candidateError(0), [
    "outside localRoot",
  ]),
  "vision.local-symlink": divergence("intentional-divergence/privacy", candidateError(0), [
    "symlink",
  ]),
  "vision.local-read-fault": divergence(
    "intentional-divergence/validation",
    candidateError(0),
    ["EACCES"],
    ["Errno 13"],
  ),
  "image.over-return-12": divergence("intentional-divergence/bounded", candidateError(1, 0), [
    "returned 12 images",
  ]),
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
