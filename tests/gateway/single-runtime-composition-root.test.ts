import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Assertion 69 ([probe-complementar] t12-single-runtime-no-server-loop): a
// single GatewaySessionRegistry / SessionRepository reused by REST, WS and
// dashboard boot -- no duplicate parallel loop. Like assertion 68, this is
// a wiring/composition-root property no HTTP golden can distinguish: two
// independently-constructed registries both backed by the same SQLite file
// would answer identical REST/WS probes for most reads, since the DB is
// the real source of truth -- the divergence only shows up in
// GatewaySessionRegistry's own in-process resurrection cache (L18/
// ADR-T12-04), which is exactly the kind of subtle, hard-to-provoke
// difference a structural check on the composition root closes directly
// instead of hoping a behavioral probe happens to catch it.
const SOURCE = readFileSync(
  resolve(import.meta.dirname, "../../src/commands/dashboard.ts"),
  "utf8",
);

function occurrences(pattern: RegExp): number {
  return [...SOURCE.matchAll(pattern)].length;
}

describe("dashboard.ts composition root: single runtime, no duplicate loop (assertion 69)", () => {
  it("constructs exactly one SessionRepository", () => {
    expect(occurrences(/new SessionRepository\(/gu)).toBe(1);
  });

  it("constructs exactly one GatewaySessionRegistry, from that same SessionRepository", () => {
    expect(occurrences(/new GatewaySessionRegistry\(/gu)).toBe(1);
    expect(SOURCE).toContain("const sessions = new SessionRepository(");
    expect(SOURCE).toContain("const registry = new GatewaySessionRegistry(sessions)");
  });

  it("threads the SAME registry instance into both the REST route handlers and the WS upgrade handler", () => {
    // Both closures reference the `registry` identifier bound above -- a
    // duplicate loop would show up here as a SECOND `new
    // GatewaySessionRegistry(...)` passed to createGatewayUpgradeHandler
    // instead of the shared variable.
    const restSection = SOURCE.slice(
      SOURCE.indexOf("const routeContext"),
      SOURCE.indexOf("const onUpgrade"),
    );
    expect(restSection).toMatch(/registry\.(list|history)\(/u);
    const wsCallSite = SOURCE.slice(SOURCE.indexOf("const onUpgrade"));
    expect(wsCallSite).toMatch(/createGatewayUpgradeHandler\(\{\s*registry,/u);
  });

  it("the per-connection conversation repository factory wraps the SAME sessions instance, not a fresh SessionRepository per connection", () => {
    expect(SOURCE).toContain(
      "createConversationRepository: () => new SqliteConversationRepository(sessions)",
    );
  });

  it("a mutant duplicating the registry for the WS path would be caught: constructing a second GatewaySessionRegistry and threading IT into createGatewayUpgradeHandler instead of the shared one would make the exactly-one-construction assertion above fail", () => {
    const mutantSource = SOURCE.replace(
      "createGatewayUpgradeHandler({\n    registry,",
      "createGatewayUpgradeHandler({\n    registry: new GatewaySessionRegistry(sessions),",
    );
    expect(mutantSource).not.toBe(SOURCE); // sanity: the replace actually matched something
    const mutantRegistryCount = [...mutantSource.matchAll(/new GatewaySessionRegistry\(/gu)].length;
    expect(mutantRegistryCount).toBe(2);
  });
});
