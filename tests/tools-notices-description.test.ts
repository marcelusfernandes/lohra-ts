// Issue #670 (residual F3, veredito PR #667 item 1): `workflow_notices`'s
// description said "Omit run_id for every scope" — since issue #652,
// `NoticesRepository.list()` without `scope` excludes `session:*` unless
// `includeSessions: true`, and the tool (`src/workflow/notices-tool.ts`)
// never passes it. The model reading the catalog text expected a
// `session:*` scope to show up too; it never does. Pinned by EQUALITY
// (`toBe`, not `toContain`), same discipline as
// `tests/tools-terminal-description.test.ts:17-25` — any future drift in
// this sentence has to touch this test too.
import { describe, expect, it } from "vitest";

import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";

function noticesDescription(): string {
  const entry = BUILTIN_DEFINITIONS.find(
    (definition) => definition.function.name === "workflow_notices",
  );
  if (entry === undefined)
    throw new Error("workflow_notices tool not found in BUILTIN_DEFINITIONS");
  return entry.function.description;
}

describe("BUILTIN_DEFINITIONS workflow_notices description matches list()'s real scope (#652, #670)", () => {
  const description = noticesDescription();

  it("no longer claims run_id is omitted for every scope", () => {
    expect(description).not.toContain("Omit run_id for every scope");
  });

  it("matches the full text byte for byte", () => {
    expect(description).toBe(
      "List durable operator notices (workflow faults, sink refusals, stale fence writes), so one a killed process left behind is still visible. Unacknowledged by default; include_acked also returns handled ones. Omit run_id to list global notices plus every run's — never another chat session's (session-scoped notices are only surfaced by the CLI).",
    );
  });
});
