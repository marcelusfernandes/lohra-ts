import { describe, expect, it } from "vitest";

import {
  CHILD_EXCLUDED_TOOLS,
  CHILD_TOOL_ALLOWLIST,
  childToolDefinitions,
} from "../src/tools/child.js";
import type { ToolDefinition } from "../src/tools/types.js";

// Contract T13 decision 2 / assertion 13a-13b (errata E2, co-signed by the
// Evaluator): src/tools/child.ts is T09's inherited, binding implementation
// — out of this ticket's edit scope. What T13 owns is proving the RELATION
// the errata requires: the TS child toolset is always a subset-or-equal of
// what the oracle's deny-list would allow, for ANY parent catalog P, not
// just today's 24-tool one. The Evaluator's structural proof is
// A ∩ E = ∅ ⇒ A ∩ P ⊆ P − E (A = the allowlist, E = the oracle's
// _CHILD_EXCLUDED_TOOLS, P = the parent's tool catalog). A proof that only
// exercises one P is not exercised — this file drives several.

const definition = (name: string): ToolDefinition => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object" } },
});

/** Simulates the oracle's deny-list filter: name not in _CHILD_EXCLUDED_TOOLS. */
function oracleDenyListNames(catalog: readonly ToolDefinition[]): readonly string[] {
  const excluded = new Set<string>(CHILD_EXCLUDED_TOOLS);
  return catalog.filter((d) => !excluded.has(d.function.name)).map((d) => d.function.name);
}

function tsAllowlistNames(catalog: readonly ToolDefinition[]): readonly string[] {
  return childToolDefinitions(catalog).map((d) => d.function.name);
}

const REAL_24_TOOL_NAMES: readonly string[] = [
  "read_file",
  "write_file",
  "terminal",
  "web_fetch",
  "web_search",
  "memory",
  "skill_view",
  "skill_manage",
  "session_search",
  "delegate_task",
  "cronjob",
  "vision_analyze",
  "image_gen",
  "spawn_session",
  "steer_session",
  "collect_session",
  "run_workflow",
  "workflow_status",
  "workflow_list",
  "workflow_pause",
  "workflow_cancel",
  "workflow_templates",
  "workflow_audit",
  "list_models",
];

describe("child toolset subset relation (errata E2)", () => {
  it("proves the algebraic premise: the allowlist and the oracle's deny-list never overlap (A ∩ E = ∅)", () => {
    const excluded = new Set<string>(CHILD_EXCLUDED_TOOLS);
    for (const allowedName of CHILD_TOOL_ALLOWLIST) {
      expect(excluded.has(allowedName)).toBe(false);
    }
  });

  const catalogs: Record<string, readonly ToolDefinition[]> = {
    "today's real 24-tool catalog": REAL_24_TOOL_NAMES.map(definition),
    "a reduced catalog (proper subset of today's)": ["read_file", "terminal", "memory"].map(
      definition,
    ),
    "today's catalog plus a fabricated/unknown tool (T19-style MCP registration)": [
      ...REAL_24_TOOL_NAMES,
      "mcp-secret-exfil",
    ].map(definition),
    "an empty catalog": [],
    "a catalog containing only excluded tools, no allowlisted ones": [
      "memory",
      "spawn_session",
      "cronjob",
    ].map(definition),
  };

  for (const [label, catalog] of Object.entries(catalogs)) {
    it(`TS never admits a tool the oracle's deny-list would refuse — ${label}`, () => {
      const oracleAllowed = new Set(oracleDenyListNames(catalog));
      const tsAllowed = tsAllowlistNames(catalog);
      for (const name of tsAllowed) {
        expect(oracleAllowed.has(name)).toBe(true);
      }
    });
  }

  it("coincides exactly with the oracle on the five real tool names, for today's catalog", () => {
    const catalog = REAL_24_TOOL_NAMES.map(definition);
    expect(tsAllowlistNames(catalog).slice().sort()).toEqual(
      oracleDenyListNames(catalog).slice().sort(),
    );
    expect(tsAllowlistNames(catalog).slice().sort()).toEqual(
      ["read_file", "terminal", "web_fetch", "web_search", "write_file"].sort(),
    );
  });

  it("diverges deliberately for an unknown/fabricated tool: oracle admits, TS refuses — inherited from t09-child-unknown-hardening", () => {
    const catalog = [...REAL_24_TOOL_NAMES, "mcp-secret-exfil"].map(definition);
    expect(oracleDenyListNames(catalog)).toContain("mcp-secret-exfil");
    expect(tsAllowlistNames(catalog)).not.toContain("mcp-secret-exfil");
  });
});
