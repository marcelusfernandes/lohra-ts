import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import { canonicalJson } from "./canonical.js";
import { HarnessError } from "./errors.js";
import type { EvidenceRecord } from "./types.js";

export function writeEvidence(path: string, evidence: EvidenceRecord): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  try {
    writeFileSync(temporary, canonicalJson(evidence), { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new HarnessError("EVIDENCE_WRITE", `Failed to write evidence ${path}`, { cause: error });
  }
}
