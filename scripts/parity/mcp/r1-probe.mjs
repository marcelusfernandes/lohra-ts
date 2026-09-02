import process from "node:process";

import {
  CHILD_EXCLUDED_TOOLS,
  childToolDefinitions,
  createBuiltinRegistry,
} from "../../../dist/tools/index.js";
import { registerServerTools } from "../../../dist/mcp/index.js";

const tools = [
  { name: "echo", description: "Echo text back.", inputSchema: { type: "object", properties: {} } },
  {
    name: "search_docs",
    description: "Search the docs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "Weird-Name!",
    description: "Sanitization probe.",
    inputSchema: { type: "object", properties: {} },
  },
];
const registry = createBuiltinRegistry();
registerServerTools(registry, "fix", tools, async () => ({ content: [], isError: false }));
const parent = registry.getDefinitions().map((entry) => entry.function.name);
const child = childToolDefinitions(registry.getDefinitions()).map((entry) => entry.function.name);
const removed = parent.filter((name) => !child.includes(name)).sort();
const excludedIntersection = CHILD_EXCLUDED_TOOLS.filter((name) => parent.includes(name)).sort();
const historicalAllowlist = ["read_file", "write_file", "terminal", "web_fetch", "web_search"];
process.stdout.write(
  `${JSON.stringify({
    parent,
    child,
    removed,
    excludedIntersection,
    removedEqualsExcludedIntersection:
      JSON.stringify(removed) === JSON.stringify(excludedIntersection),
    AIntersectEIsEmpty: historicalAllowlist.every((name) => !CHILD_EXCLUDED_TOOLS.includes(name)),
    AIntersectPSubsetOfPMinusE: historicalAllowlist
      .filter((name) => parent.includes(name))
      .every((name) => child.includes(name)),
  })}\n`,
);
