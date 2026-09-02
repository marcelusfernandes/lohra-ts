import type Database from "better-sqlite3";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelTransport } from "../conversation/index.js";
import { CronStore } from "../cron/store.js";
import { CronTool } from "../cron/tool.js";
import { createMediaBindings, type ImageGenerationPort } from "../media/index.js";
import { MemoryStore } from "../memory/index.js";
import type { SessionRepository } from "../state/index.js";
import { AuditRepository } from "../state/index.js";
import { SkillStore } from "../skills/index.js";
import {
  createBuiltinRegistry,
  ListModelsTool,
  MemoryTool,
  SessionSearchTool,
  SkillTool,
  type ToolDefinition,
  type ToolHandler,
  type ToolRegistry,
} from "../tools/index.js";
import type { WorkflowService } from "../workflow/index.js";
import { workflowAuditHandler, workflowToolHandlers } from "../workflow/index.js";

export interface SessionToolBase {
  readonly registry: ToolRegistry;
  readonly auditRepository: AuditRepository;
}

export interface SessionToolComposition {
  readonly registry: ToolRegistry;
  readonly dispatch: ToolRegistry["dispatch"];
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly toolNames: readonly string[];
}

export function createSessionToolBase(
  database: Database.Database,
  environment: Readonly<Record<string, string | undefined>>,
): SessionToolBase {
  const auditRepository = new AuditRepository(database, { environment });
  const registry = createBuiltinRegistry({
    workflow_audit: workflowAuditHandler(auditRepository),
  });
  return Object.freeze({ registry, auditRepository });
}

export function composeSessionTools(options: {
  readonly base: SessionToolBase;
  readonly home: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly sessions: SessionRepository;
  readonly workflowService: WorkflowService;
  readonly orchestrationHandlers: Readonly<Record<string, ToolHandler>>;
  readonly visionRunner: ModelTransport;
  readonly imageGenerator?: ImageGenerationPort;
  readonly visionModel: string;
  readonly imageModel?: string;
  readonly supportsVision: boolean;
}): SessionToolComposition {
  const memoryTool = new MemoryTool(new MemoryStore(options.home));
  const builtinSkills = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../assets/skills/workflow-authoring",
  );
  const skillTool = new SkillTool(
    new SkillStore(options.home, [join(options.cwd, ".claude", "skills")], [builtinSkills]),
  );
  const listModels = new ListModelsTool(options.home, options.environment);
  const cronTool = new CronTool(new CronStore(options.home));
  const imageGenerator: ImageGenerationPort = options.imageGenerator ?? {
    generate: () => Promise.reject(new Error("image generation is unavailable for this provider")),
  };
  const media = createMediaBindings({
    baseDispatch: options.base.registry.dispatch.bind(options.base.registry),
    localRoot: options.cwd,
    outDir: join(options.home, "images"),
    visionRunner: options.visionRunner,
    imageGenerator,
    visionModel: options.visionModel,
    ...(options.imageModel === undefined ? {} : { imageModel: options.imageModel }),
    supportsVision: options.supportsVision,
  });
  options.base.registry.overrideHandlers({
    memory: (args) => memoryTool.handle(args),
    skill_view: (args) => skillTool.view(args),
    skill_manage: (args) => skillTool.manage(args),
    session_search: (args) => new SessionSearchTool(options.sessions).handle(args),
    list_models: (args) => listModels.handle(args),
    cronjob: (args) => cronTool.handle(args),
    ...workflowToolHandlers(options.workflowService, options.base.auditRepository),
    ...options.orchestrationHandlers,
    ...media.handlers,
  });
  const toolDefinitions = options.base.registry.getDefinitions();
  return Object.freeze({
    registry: options.base.registry,
    dispatch: options.base.registry.dispatch.bind(options.base.registry),
    toolDefinitions,
    toolNames: Object.freeze(toolDefinitions.map((entry) => entry.function.name)),
  });
}
