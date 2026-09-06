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
    pattern:
      '(\\\\?"run_id\\\\?":\\s*\\\\?")([0-9a-f]{16,}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})',
    replacement: "$1<run-id>",
    why: "the service generates it per run; it also appears JSON-escaped inside captured tool messages, so both quote forms match",
  }),
  Object.freeze({
    field: "system_prompt.today",
    kind: "structural-replace-regex",
    pattern: "(Today's date is )\\d{4}-\\d{2}-\\d{2}",
    replacement: "$1<date>",
    scope: "message objects whose role is exactly system; only their string content is normalized",
    why: "the system prompt states the current date on both sides, so an artifact captured on one day cannot be byte-compared with one captured on the next; identical text in user/tool messages remains semantic",
  }),
]);

const RUN_ID =
  /(\\?"run_id\\?":\s*\\?")([0-9a-f]{16,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/g;
const TODAY = /(Today's date is )\d{4}-\d{2}-\d{2}/g;

/** Normalize only the structural field declared above. */
function normalizeSystemPromptToday(value) {
  if (Array.isArray(value)) {
    for (const entry of value) normalizeSystemPromptToday(entry);
    return;
  }
  if (value === null || typeof value !== "object") return;

  if (value.role === "system" && typeof value.content === "string") {
    value.content = value.content.replaceAll(TODAY, "$1<date>");
  }
  for (const entry of Object.values(value)) normalizeSystemPromptToday(entry);
}

/** Apply the declared rules, and nothing else, to one artifact's bytes. */
export function normalizeEvidence(text) {
  const runIdsNormalized = text.replaceAll(RUN_ID, "$1<run-id>");
  const parsed = JSON.parse(runIdsNormalized);
  normalizeSystemPromptToday(parsed);

  const pretty = runIdsNormalized.includes("\n");
  const serialized = JSON.stringify(parsed, null, pretty ? 2 : undefined);
  return runIdsNormalized.endsWith("\n") ? `${serialized}\n` : serialized;
}
