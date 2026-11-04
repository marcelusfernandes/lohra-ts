// Issue #970 (épico #969): `workflow_save`'s schema, appended LAST to
// `BUILTIN_DEFINITIONS` — kept in its own module so `builtin-definitions.ts`
// stays under the repo's 800-line contract (`contratos`, arquivo-grande).
import type { ToolDefinition } from "./types.js";

export const WORKFLOW_SAVE_DEFINITION = {
  type: "function",
  function: {
    description:
      "Save a 'complete' workflow run's spec as a reusable template under a NEW 'ref' (never overwrites; a new version is a new ref). Save only a shape worth repeating; it then shows in workflow_templates.",
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "A run whose status is 'complete'." },
        ref: { type: "string", description: "New template name: [a-z0-9][a-z0-9_-]{0,63}." },
        description: { type: "string", description: "What it is for (max 1024 chars)." },
      },
      required: ["run_id", "ref", "description"],
    },
    name: "workflow_save",
  },
} as const satisfies ToolDefinition;
