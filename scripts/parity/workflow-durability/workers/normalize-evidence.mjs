#!/usr/bin/env node
// The declared normalization applied to the evidence artifacts this suite
// DELIVERS, so a digest quoted in a handoff can be verified later.
//
// Manifest `normalizations` govern the COMPARISON; the captured artifact keeps
// what was actually seen. Two things in that capture are volatile and carry no
// meaning for the comparison: the run id the service generates, and the date
// the system prompt states. Everything else — requests, responses, headers,
// statuses, every other id — is left exactly as captured. Masking more than
// this would hide divergence, which is the opposite of the point.

/** Each rule is recorded in the evidence record alongside the digests. */
export const EVIDENCE_NORMALIZATIONS = Object.freeze([
  Object.freeze({
    field: "run_id",
    kind: "replace-regex",
    pattern: '(\\\\?"run_id\\\\?":\\s*\\\\?")([0-9a-f]{16,}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})',
    replacement: "$1<run-id>",
    why: "the service generates it per run; it also appears JSON-escaped inside captured tool messages, so both quote forms match",
  }),
  Object.freeze({
    field: "system_prompt.today",
    kind: "replace-regex",
    pattern: "(Today's date is )\\d{4}-\\d{2}-\\d{2}",
    replacement: "$1<date>",
    why: "the system prompt states the current date on both sides, so an artifact captured on one day cannot be byte-compared with one captured on the next",
  }),
]);

const RUN_ID =
  /(\\?"run_id\\?":\s*\\?")([0-9a-f]{16,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/g;
const TODAY = /(Today's date is )\d{4}-\d{2}-\d{2}/g;

/** Apply the declared rules, and nothing else, to one artifact's bytes. */
export function normalizeEvidence(text) {
  return text.replaceAll(RUN_ID, "$1<run-id>").replaceAll(TODAY, "$1<date>");
}
