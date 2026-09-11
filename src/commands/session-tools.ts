import type Database from "better-sqlite3";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelTransport } from "../conversation/index.js";
import { CronStore } from "../cron/store.js";
import { CronTool } from "../cron/tool.js";
import { createMediaBindings, type ImageGenerationPort } from "../media/index.js";
import { MemoryStore } from "../memory/index.js";
import type { Ownership, SessionRepository } from "../state/index.js";
import { AuditRepository, NoticesRepository } from "../state/index.js";
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
// Issue #401: not re-exported by `../workflow/index.js` — same convention
// `chat.ts` already follows for `WorkflowLiveTail` (`live-tail.ts`).
import { createNoticesSink, type NoticesSink } from "../workflow/notices-sink.js";
// Issue #402: same convention — `workflowNoticesHandler`/`workflowNoticesAckHandler`
// live in their own module (`notices-tool.ts`, not `tool.ts`), not re-exported.
import { workflowNoticesAckHandler, workflowNoticesHandler } from "../workflow/notices-tool.js";
// Issue #425: same convention — `workflowLeafReadHandler` lives in its own
// module (`leaf-read-tool.ts`, not `tool.ts`), not re-exported.
import { workflowLeafReadHandler } from "../workflow/leaf-read-tool.js";

export interface SessionToolBase {
  readonly registry: ToolRegistry;
  readonly auditRepository: AuditRepository;
  /** The ONE notices sink this process builds (issue #401) — every other
   * composition-root wiring (`WorkflowService.onWarning`, `AuditTrail`,
   * `WorkflowLiveTail`, the ownership store's `StateWarning` sink) reuses
   * THIS instance, never a second one. */
  readonly noticesSink: NoticesSink;
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
  options: {
    // Issue #401: resolves the CURRENT ownership for a `StateWarning`'s
    // run — the caller (chat.ts, dashboard.ts) is the one that ends up
    // holding the ownership store, built AFTER this factory returns, so
    // this is a lazy forward-reference, not a value.
    readonly ownership?: (runId: string) => Ownership | null;
  } = {},
): SessionToolBase {
  // Issue #400/#401: its OWN `warning` stays the default no-op — wiring it
  // to `noticesSink.warn` would recurse (a refused notice would warn,
  // which would append, which would refuse, …); wiring it to
  // `console.warn` directly would add a stderr line this sink's own
  // `warn()` already prints once, doubling it and breaking the
  // byte-fixed assertion (`src/gateway/failure-log.ts:4-10`). `dropped`
  // in `stats()` is the observability for an append this repository
  // itself refuses.
  const noticesRepository = new NoticesRepository(database);
  const noticesSink = createNoticesSink({
    repository: noticesRepository,
    ...(options.ownership === undefined ? {} : { ownership: options.ownership }),
    fallback: (message: string): void => {
      console.warn(message);
    },
  });
  // Issue #380: production roots (chat.ts, dashboard.ts) pass the same
  // sink WorkflowService itself falls back to, so a fence refusal on the
  // audit trail is exactly as observable as one on the ownership store —
  // the prior default here was `() => undefined`, and "recusa nunca
  // silenciosa" (#368) only held for tests with a sink injected. Issue
  // #401 unifies that sink into `noticesSink.warn`: still calls
  // `console.warn` (via `noticesSink`'s own fallback) exactly once per
  // warning, now ALSO recorded durably.
  const auditRepository = new AuditRepository(database, {
    environment,
    warning: noticesSink.warn,
  });
  const registry = createBuiltinRegistry({
    workflow_audit: workflowAuditHandler(auditRepository),
    workflow_notices: workflowNoticesHandler(noticesRepository),
    workflow_notices_ack: workflowNoticesAckHandler(noticesRepository),
    workflow_leaf_read: workflowLeafReadHandler(database, auditRepository),
  });
  return Object.freeze({ registry, auditRepository, noticesSink });
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
