import { describe, expect, it } from "vitest";

import {
  CHILD_EXCLUDED_TOOLS,
  childToolDefinitions,
} from "../src/tools/child.js";
import type { ToolDefinition } from "../src/tools/types.js";

// T13 Errata E2 proved the historical subset relation on its approved SHA.
// T19 R1 explicitly supersedes that visibility mechanism at integration:
// the candidate now computes P − E directly, so every catalog below proves
// equality with the oracle instead of only allow-list containment.

const definition = (name: string): ToolDefinition => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object" } },
});

/** Simulates the oracle's deny-list filter: name not in _CHILD_EXCLUDED_TOOLS. */
function oracleDenyListNames(catalog: readonly ToolDefinition[]): readonly string[] {
  const excluded = new Set<string>(CHILD_EXCLUDED_TOOLS);
  return catalog.filter((d) => !excluded.has(d.function.name)).map((d) => d.function.name);
}

function tsChildNames(catalog: readonly ToolDefinition[]): readonly string[] {
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
  it("uses the complete, unique 19-name oracle exclusion set", () => {
    expect(CHILD_EXCLUDED_TOOLS).toHaveLength(19);
    expect(new Set(CHILD_EXCLUDED_TOOLS).size).toBe(19);
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
    it(`TS equals the oracle's deny-list projection — ${label}`, () => {
      expect(tsChildNames(catalog)).toEqual(oracleDenyListNames(catalog));
    });
  }

  it("coincides exactly with the oracle on the five real tool names, for today's catalog", () => {
    const catalog = REAL_24_TOOL_NAMES.map(definition);
    expect(tsChildNames(catalog).slice().sort()).toEqual(
      oracleDenyListNames(catalog).slice().sort(),
    );
    expect(tsChildNames(catalog).slice().sort()).toEqual(
      ["read_file", "terminal", "web_fetch", "web_search", "write_file"].sort(),
    );
  });

  it("admits an unknown/MCP-style tool exactly as the oracle does after T19 R1", () => {
    const catalog = [...REAL_24_TOOL_NAMES, "mcp-secret-exfil"].map(definition);
    expect(oracleDenyListNames(catalog)).toContain("mcp-secret-exfil");
    expect(tsChildNames(catalog)).toContain("mcp-secret-exfil");
  });
});
