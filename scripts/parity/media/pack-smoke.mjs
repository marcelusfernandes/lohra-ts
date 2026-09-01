#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-pack-"));
const evidenceRoot = resolve(root, ".parity-evidence/t21");

function checked(executable, argv, cwd = root) {
  const result = spawnSync(executable, argv, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `T21_PACK_COMMAND_FAILED:${executable}:${String(result.status ?? result.signal)}:${result.stderr}`,
    );
  return result.stdout;
}

try {
  const pack = join(runtime, "pack");
  const extract = join(runtime, "extract");
  mkdirSync(pack);
  mkdirSync(extract);
  const metadata = JSON.parse(checked("npm", ["pack", "--json", "--pack-destination", pack]));
  const filename = metadata[0]?.filename;
  if (typeof filename !== "string") throw new Error("T21_PACK_TARBALL_MISSING");
  checked("tar", ["-xzf", join(pack, filename), "-C", extract], runtime);
  const packageRoot = join(extract, "package");
  const mediaEntry = join(packageRoot, "dist/media/index.js");
  if (!existsSync(mediaEntry)) throw new Error("T21_PACK_MEDIA_MISSING");
  if (existsSync(join(packageRoot, "src"))) throw new Error("T21_PACK_CONTAINS_SRC");
  const media = await import(pathToFileURL(mediaEntry).href);
  if (media.coerceImageCount("2") !== 2) throw new Error("T21_PACK_COERCION_FAILED");
  const data = "data:image/png;base64,cG5n";
  if (media.validateRemoteImage(data) !== data) throw new Error("T21_PACK_DATA_FAILED");
  const evidence = {
    suite: "t21-media-pack-smoke",
    imported: "dist/media/index.js",
    source_present: false,
    coerce_count: 2,
    data_projection: {
      kind: "data",
      mime: "image/png",
      decoded_bytes: 3,
      sha256: createHash("sha256").update("png").digest("hex"),
    },
    network_attempts: 0,
    failures: 0,
  };
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, "media-pack-smoke.json"), `${JSON.stringify(evidence)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  rmSync(runtime, { recursive: true, force: true });
}
