import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import { canonicalJson } from "./canonical.js";
import { HarnessError } from "./errors.js";
import { assertCredentialClean } from "./scrub.js";
import type { EvidenceRecord, ScenarioManifest } from "./types.js";

export function writeEvidence(
  path: string,
  evidence: EvidenceRecord,
  manifest?: ScenarioManifest,
): void {
  const content = canonicalJson(evidence);
  if (manifest?.scrub !== undefined) {
    try {
      assertCredentialClean(content, evidence, manifest.fixtures, manifest.scrub);
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new HarnessError("EVIDENCE_WRITE", `Failed to write evidence ${path}`, { cause: error });
  }
}
