import { BUILTIN_DEFINITIONS } from "./builtin-definitions.js";
import { toolError } from "./envelope.js";
import { readFileTool, writeFileTool } from "./filesystem.js";
import { registry, ToolRegistry } from "./registry.js";
import { webFetchHandler, webSearchHandler } from "../web/tool.js";
import { terminalTool } from "./terminal.js";
import type { ToolHandler } from "./types.js";

const failSafe =
  (message: string): ToolHandler =>
  () =>
    toolError(message);

const FAIL_SAFE_HANDLERS: Readonly<Record<string, ToolHandler>> = {
  memory: failSafe("the memory tool must be intercepted with a session MemoryStore"),
  skill_view: failSafe("skill tools must be intercepted with a session SkillStore"),
  skill_manage: failSafe("skill tools must be intercepted with a session SkillStore"),
  session_search: failSafe("session_search must be intercepted with a session SessionDB"),
  list_models: failSafe("list_models must be intercepted with a session home"),
  cronjob: failSafe("the cronjob tool must be intercepted with a session CronStore"),
  vision_analyze: failSafe("the vision_analyze tool must be intercepted with a session runner"),
  image_gen: failSafe("the image_gen tool must be intercepted with a session runner"),
  spawn_session: failSafe("orchestration tools must be intercepted with a session core"),
  steer_session: failSafe("orchestration tools must be intercepted with a session core"),
  collect_session: failSafe("orchestration tools must be intercepted with a session core"),
  delegate_task: failSafe(
    "the delegate_task tool must be intercepted with a session orchestration core",
  ),
  run_workflow: failSafe("workflow tools must be intercepted with a session WorkflowService"),
  workflow_status: failSafe("workflow tools must be intercepted with a session WorkflowService"),
  workflow_list: failSafe("workflow tools must be intercepted with a session WorkflowService"),
  workflow_pause: failSafe("workflow tools must be intercepted with a session WorkflowService"),
  workflow_cancel: failSafe("workflow tools must be intercepted with a session WorkflowService"),
  workflow_templates: failSafe("workflow tools must be intercepted with a session WorkflowService"),
  workflow_audit: failSafe("workflow_audit must be intercepted with a SessionDB"),
};

function toolset(name: string): string {
  if (name === "read_file" || name === "write_file") return "file";
  if (name === "terminal") return "terminal";
  if (name.startsWith("web_")) return "web";
  if (name.startsWith("skill_")) return "skills";
  if (name.startsWith("workflow_")) return "workflow";
  return name;
}

function handler(name: string): ToolHandler {
  if (name === "read_file") return readFileTool;
  if (name === "write_file") return writeFileTool;
  if (name === "terminal") return terminalTool;
  if (name === "web_fetch") return webFetchHandler;
  if (name === "web_search") return webSearchHandler;
  const intercepted = FAIL_SAFE_HANDLERS[name];
  if (intercepted === undefined) return failSafe(`no local handler registered for ${name}`);
  return intercepted;
}

function registerBuiltins(
  target: ToolRegistry,
  overrides: Readonly<Record<string, ToolHandler>> = {},
): ToolRegistry {
  for (const definition of BUILTIN_DEFINITIONS) {
    const { name, ...schema } = definition.function;
    target.register({
      name,
      toolset: toolset(name),
      schema,
      handler: overrides[name] ?? handler(name),
    });
  }
  return target;
}

export function createBuiltinRegistry(
  overrides: Readonly<Record<string, ToolHandler>> = {},
): ToolRegistry {
  return registerBuiltins(new ToolRegistry(), overrides);
}

export const builtinRegistry = registerBuiltins(registry);
