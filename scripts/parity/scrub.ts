import { existsSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";

import { HarnessError } from "./errors.js";
import type { EvidenceRecord, FixtureSpec, ScrubSpec } from "./types.js";

const MAX_CREDENTIAL_BYTES = 1_000_000;
const operatorFiles = [".codex/auth.json", ".lohra/auth.json", ".lohra/oauth.json"] as const;
const tokenKeys = new Set(["access_token", "refresh_token", "id_token"]);
const operatorKeys = new Set([...tokenKeys, "account_id", "chatgpt_account_id", "organization_id"]);

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function collect(
  value: unknown,
  sensitiveKeys: ReadonlySet<string>,
  markers: Set<string>,
  minimumLength: number,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, sensitiveKeys, markers, minimumLength);
    return;
  }
  const record = object(value);
  if (record === null) return;
  for (const [key, entry] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    if (
      sensitiveKeys.has(normalized) &&
      typeof entry === "string" &&
      entry.length >= minimumLength
    ) {
      markers.add(entry);
      if (normalized.includes("token"))
        collectJwtClaims(entry, sensitiveKeys, markers, minimumLength);
    }
    collect(entry, sensitiveKeys, markers, minimumLength);
  }
}

function collectJwtClaims(
  token: string,
  sensitiveKeys: ReadonlySet<string>,
  markers: Set<string>,
  minimumLength: number,
): void {
  const segments = token.split(".");
  if (segments.length >= 3) {
    for (const segment of segments) {
      if (segment.length >= 4) markers.add(segment);
    }
  }
  const payload = segments[1];
  if (payload === undefined) return;
  try {
    collect(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown,
      sensitiveKeys,
      markers,
      minimumLength,
    );
  } catch {
    // Opaque tokens are still checked as complete marker strings.
  }
}

function parseMarkers(
  content: string,
  sensitiveKeys: ReadonlySet<string>,
  markers: Set<string>,
  label: string,
  minimumLength: number,
): void {
  try {
    collect(JSON.parse(content) as unknown, sensitiveKeys, markers, minimumLength);
  } catch (error) {
    throw new HarnessError(
      "CREDENTIAL_SCRUB_READ",
      `Could not parse credential marker source ${label}`,
      {
        cause: error,
      },
    );
  }
}

function fixtureMarkers(fixtures: readonly FixtureSpec[]): Set<string> {
  const markers = new Set<string>();
  for (const fixture of fixtures) {
    const content =
      fixture.encoding === "base64"
        ? Buffer.from(fixture.content, "base64").toString("utf8")
        : fixture.content;
    try {
      collect(JSON.parse(content) as unknown, tokenKeys, markers, 4);
    } catch {
      // Non-JSON fixtures cannot contain structured credential fields.
    }
  }
  return markers;
}

function realMarkers(operatorHome: string): Set<string> {
  const markers = new Set<string>();
  for (const relative of operatorFiles) {
    const path = resolve(operatorHome, relative);
    if (!existsSync(path)) continue;
    let content: string;
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > MAX_CREDENTIAL_BYTES) {
        throw new Error("credential marker source is not a bounded file");
      }
      content = readFileSync(path, "utf8");
    } catch (error) {
      throw new HarnessError(
        "CREDENTIAL_SCRUB_READ",
        `Could not read credential marker source ${relative}`,
        { cause: error },
      );
    }
    parseMarkers(content, operatorKeys, markers, relative, 24);
  }
  return markers;
}

const decodedStreams = (evidence: EvidenceRecord): readonly string[] => [
  Buffer.from(evidence.runs.oracle.process.stdout, "base64").toString("utf8"),
  Buffer.from(evidence.runs.oracle.process.stderr, "base64").toString("utf8"),
  Buffer.from(evidence.runs.candidate.process.stdout, "base64").toString("utf8"),
  Buffer.from(evidence.runs.candidate.process.stderr, "base64").toString("utf8"),
];

export function assertCredentialClean(
  evidenceText: string,
  evidence: EvidenceRecord,
  fixtures: readonly FixtureSpec[],
  policy: ScrubSpec,
  operatorHome = userInfo().homedir,
): void {
  const markers = new Set<string>();
  if (policy.fixtureTokens) {
    for (const marker of fixtureMarkers(fixtures)) markers.add(marker);
  }
  if (policy.operatorCredentials) {
    for (const marker of realMarkers(operatorHome)) markers.add(marker);
  }
  const values = [evidenceText, ...decodedStreams(evidence)];
  if ([...markers].some((marker) => values.some((value) => value.includes(marker)))) {
    throw new HarnessError("CREDENTIAL_LEAK", "Credential marker reached parity evidence");
  }
}
