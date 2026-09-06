import { describe, expect, it } from "vitest";

import { getProviderProfile } from "../../src/providers/index.js";
import { resolveResponsesProfile } from "../../scripts/parity/provider-transports/responses-profile.js";

// live-smoke.mjs's smokeResponses() must resolve the codex provider from
// resolveResponsesProfile(), not by looking it up in the registry — a
// prior version called getProviderProfile("openai-codex") directly and
// silently refused every run before ever reading a credential, because
// CODEX_PROVIDER is deliberately absent from the registry (T10's
// tests/providers-t10.test.ts pins getProviderProfile("openai-codex")
// as null). This test exercises the exact function the live-smoke script
// calls, not just the underlying registry primitives — those are already
// covered by providers-t10.test.ts and did not catch this defect, because
// the bug was in which function the script called, not in what either
// function returns on its own.
//
// resolveResponsesProfile here comes from responses-profile.ts, a twin of
// live-smoke.mjs's responses-profile.mjs (issue #2). The .mjs one imports
// CODEX_PROVIDER from dist/ on purpose — live-smoke.mjs is a real smoke
// test of the compiled package, run with plain `node`, never `tsx` — so it
// can't run against a checkout without `npm run build`. This test only
// needs to prove the resolution logic never falls back to the by-name
// registry lookup; the .ts twin imports the same CODEX_PROVIDER straight
// from src/, so `npm test` never requires `dist/` to exist.
describe("live-smoke responses/codex profile resolution", () => {
  it("resolves the codex profile the same way the real subscription path does", () => {
    const profile = resolveResponsesProfile();
    expect(profile).toMatchObject({
      name: "openai-codex",
      apiMode: "responses",
      fallbackModels: ["gpt-5.5"],
    });
  });

  it("documents why: getProviderProfile would refuse it by name", () => {
    expect(getProviderProfile("openai-codex")).toBeNull();
  });
});
