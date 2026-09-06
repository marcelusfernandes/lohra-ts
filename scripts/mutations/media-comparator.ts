// Movido do comparador do runner de paridade aposentado (issue #151, passo
// 0d do épico #13): `scripts/mutations/**` não importa nada do diretório
// aposentado, então o comparador vem para cá e passa a usar a cópia local
// de `canonical.ts` (#148).
import { canonicalJson } from "./canonical.js";

export type MediaClassification =
  | "match"
  | "intentional-divergence/privacy"
  | "intentional-divergence/validation"
  | "intentional-divergence/bounded"
  | "intentional-divergence/atomicity";

export interface MediaRow {
  readonly id: string;
  readonly value: unknown;
}

export interface DivergenceSpec {
  readonly classification: Exclude<MediaClassification, "match">;
  readonly candidate: unknown;
  /** Substrings the candidate error message must contain (wrong-reason guard). */
  readonly candidateErrorIncludes?: readonly string[];
  /** Substrings the oracle error message must contain (oracle-drift guard). */
  readonly oracleErrorIncludes?: readonly string[];
}

export interface MediaComparison {
  readonly id: string;
  readonly classification: MediaClassification | "unclassified";
  readonly pass: boolean;
  readonly oracle: unknown;
  readonly candidate: unknown;
  readonly reason: string | null;
}

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "object" || expected === null) {
    return canonicalJson(actual) === canonicalJson(expected);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((entry, index) => contains(actual[index], entry));
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(
    ([key, value]) => key in actual && contains((actual as Record<string, unknown>)[key], value),
  );
}

function mapRows(rows: readonly MediaRow[], side: string): ReadonlyMap<string, unknown> {
  const result = new Map<string, unknown>();
  for (const row of rows) {
    if (result.has(row.id)) throw new Error(`duplicate ${side} media row: ${row.id}`);
    result.set(row.id, row.value);
  }
  return result;
}

export function compareMediaRows(
  oracleRows: readonly MediaRow[],
  candidateRows: readonly MediaRow[],
  divergences: Readonly<Record<string, DivergenceSpec>> = {},
): readonly MediaComparison[] {
  const oracle = mapRows(oracleRows, "oracle");
  const candidate = mapRows(candidateRows, "candidate");
  const ids = [...new Set([...oracle.keys(), ...candidate.keys()])].sort();
  return Object.freeze(
    ids.map((id) => {
      const oracleValue = oracle.get(id);
      const candidateValue = candidate.get(id);
      if (!oracle.has(id) || !candidate.has(id)) {
        return {
          id,
          classification: "unclassified" as const,
          pass: false,
          oracle: oracleValue,
          candidate: candidateValue,
          reason: !oracle.has(id) ? "missing oracle row" : "missing candidate row",
        };
      }
      const equal = canonicalJson(oracleValue) === canonicalJson(candidateValue);
      const policy = divergences[id];
      if (equal) {
        return {
          id,
          classification: "match" as const,
          pass: policy === undefined,
          oracle: oracleValue,
          candidate: candidateValue,
          reason: policy === undefined ? null : "expected divergence disappeared",
        };
      }
      if (policy === undefined) {
        return {
          id,
          classification: "unclassified" as const,
          pass: false,
          oracle: oracleValue,
          candidate: candidateValue,
          reason: "unclassified functional difference",
        };
      }
      const errorOf = (value: unknown): string | null => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
        const message = (value as Record<string, unknown>)["error"];
        return typeof message === "string" ? message : null;
      };
      const candidateError = errorOf(candidateValue);
      const oracleError = errorOf(oracleValue);
      const candidateFragments = policy.candidateErrorIncludes ?? [];
      const oracleFragments = policy.oracleErrorIncludes ?? [];
      const candidateMatches = candidateFragments.every((fragment) =>
        typeof candidateError === "string" ? candidateError.includes(fragment) : false,
      );
      const oracleMatches = oracleFragments.every((fragment) =>
        typeof oracleError === "string" ? oracleError.includes(fragment) : false,
      );
      const pass = contains(candidateValue, policy.candidate) && candidateMatches && oracleMatches;
      return {
        id,
        classification: policy.classification,
        pass,
        oracle: oracleValue,
        candidate: candidateValue,
        reason: pass
          ? null
          : candidateMatches && oracleMatches
            ? "candidate does not satisfy the approved divergence shape"
            : oracleMatches
              ? "candidate error message does not match the approved divergence reason"
              : "oracle error message does not match the approved divergence reason",
      };
    }),
  );
}
