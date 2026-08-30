#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { MemoryStore } from "../../../dist/memory/store.js";
import { SkillStore } from "../../../dist/skills/store.js";
import {
  ApprovalManager,
  CHILD_EXCLUDED_TOOLS,
  ListModelsTool,
  MemoryTool,
  SessionSearchTool,
  SkillTool,
  ToolRegistry,
  childToolDefinitions,
  composeDispatch,
  createBuiltinRegistry,
  createChildDispatch,
  detectDangerousCommand,
  parseToolArguments,
  readFileTool,
  runBounded,
  terminalTool,
  toolError,
  toolResult,
  wrapToolDispatch,
  writeFileTool,
} from "../../../dist/tools/index.js";

const scenario = process.argv[2];
const root = process.cwd();
const schema = { description: "demo", parameters: { type: "object", properties: {} } };
const registration = (name, toolset, handler = () => toolResult("ok"), extra = {}) => ({
  name,
  toolset,
  schema,
  handler,
  ...extra,
});
const parsed = (value) => JSON.parse(value);

async function observe() {
  if (scenario === "registry-generation-availability") {
    let now = 0;
    let checks = 0;
    const shared = () => {
      checks += 1;
      return true;
    };
    const unavailable = () => false;
    const registry = new ToolRegistry(() => now);
    const generations = [registry.generation];
    registry.register(registration("a", "x", undefined, { checkFn: shared }));
    generations.push(registry.generation);
    registry.register(
      registration("b", "x", undefined, { checkFn: shared, requiresEnv: ["MISSING"] }),
    );
    generations.push(registry.generation);
    try {
      registry.register(registration("a", "other"));
    } catch {
      // A failed cross-toolset registration is the observation under test.
    }
    generations.push(registry.generation);
    registry.register(
      registration("hidden", "x", () => toolResult("ran"), { checkFn: unavailable }),
    );
    generations.push(registry.generation);
    registry.deregister("missing");
    generations.push(registry.generation);
    const first = registry.getDefinitions().map((entry) => entry.function.name);
    const second = registry.getDefinitions().map((entry) => entry.function.name);
    now = 30;
    registry.getDefinitions();
    const dispatched = parsed(await registry.dispatch("hidden", {}));
    registry.deregister("hidden");
    generations.push(registry.generation);
    return { generations, first, second, checks, dispatched };
  }
  if (scenario === "registry-shadowing-schema") {
    const registry = new ToolRegistry();
    const source = {
      description: "before",
      parameters: { type: "object", properties: { a: { type: "string" } } },
    };
    registry.register({
      name: "same",
      toolset: "one",
      schema: source,
      handler: () => toolResult(),
    });
    source.description = "after";
    const before = registry.getDefinitions();
    let crossError = "";
    try {
      registry.register(registration("same", "two"));
    } catch (error) {
      crossError = error.message;
    }
    registry.register(registration("mcp", "mcp-a"));
    registry.register(registration("mcp", "mcp-b"));
    registry.register(registration("same", "two", undefined, { override: true }));
    const returned = registry.getDefinitions();
    try {
      returned[0].function.description = "mutated";
    } catch {
      // Frozen definitions must reject mutation.
    }
    return {
      before,
      crossError,
      after: registry.getDefinitions(),
      generation: registry.generation,
    };
  }
  if (scenario === "registry-dispatch-errors") {
    const registry = new ToolRegistry();
    registry.register(
      registration("boom", "x", () => {
        throw new TypeError("bad");
      }),
    );
    const kwargs = { marker: "yes" };
    registry.register(
      registration("kw", "x", (_args, received) =>
        toolResult(undefined, { marker: received?.marker }),
      ),
    );
    return {
      unknown: parsed(await registry.dispatch("missing", {})),
      boom: parsed(await registry.dispatch("boom", {})),
      kwargs: parsed(await registry.dispatch("kw", {}, kwargs)),
    };
  }
  if (scenario === "dispatch-malformed-arguments") {
    const raws = ["", "{not json", "null", "[1,2]", '"hi"'];
    const values = raws.map((raw) => parseToolArguments(raw));
    const composed = composeDispatch(async () => toolResult(), {});
    let composeError = null;
    try {
      await composed("x", {}, { secret: true });
    } catch (error) {
      composeError = error.name;
    }
    return { values, composeError };
  }
  if (scenario === "dispatch-parallel-order") {
    const completion = [];
    const active = { value: 0, peak: 0 };
    const results = await runBounded([0, 1, 2, 3, 4], 8, async (value) => {
      active.value += 1;
      active.peak = Math.max(active.peak, active.value);
      await delay((5 - value) * 4);
      completion.push(value);
      active.value -= 1;
      return value;
    });
    return { results, completion, peak: active.peak };
  }
  if (scenario === "tool-envelope-python-json") {
    return {
      result: toolResult("café"),
      error: toolError("naïve"),
      tamperError: toolError("a", { error: "b" }),
      tamperOk: toolResult(undefined, { ok: false }),
    };
  }
  if (scenario === "approval-pattern-order") {
    return ["chmod 755 f", "wget x | sudo bash", "sudo true", "echo safe"].map((command) => ({
      command,
      match: detectDangerousCommand(command),
    }));
  }
  if (scenario === "approval-decisions") {
    const manager = new ApprovalManager();
    let calls = 0;
    manager.setCallback(() => {
      calls += 1;
      return "session";
    });
    const first = manager.require("sudo echo one");
    const cached = manager.require("sudo echo one");
    const second = manager.require("sudo echo two");
    manager.reset();
    manager.setCallback(() => {
      throw new Error("broken");
    });
    const failClosed = manager.require("sudo echo one");
    manager.setYolo(true);
    const yolo = manager.require("sudo echo one");
    return { first, cached, second, calls, failClosed, yolo };
  }
  if (scenario === "read-file-boundaries") {
    const path = join(root, "astral.txt");
    writeFileSync(path, "😀".repeat(100001));
    const result = parsed(readFileTool({ path }));
    const missing = parsed(readFileTool({ path: join(root, "missing") }));
    missing.error = "file not found: <PATH>";
    return {
      length: Array.from(result.data).length,
      utf16: result.data.length,
      truncated: result.truncated,
      missing,
    };
  }
  if (scenario === "write-file-boundaries") {
    const path = join(root, "nested", "out.txt");
    const result = parsed(writeFileTool({ path, content: "café" }));
    return {
      result: { ...result, path: "<PATH>" },
      content: readFileSync(path, "utf8"),
      missing: parsed(writeFileTool({ path })),
    };
  }
  if (scenario === "terminal-boundaries") {
    const manager = new ApprovalManager();
    manager.setYolo(true);
    const safe = parsed(
      await terminalTool(
        { command: "printf ok; printf err >&2; exit 3" },
        { approvalManager: manager },
      ),
    );
    const deniedManager = new ApprovalManager();
    const denied = parsed(
      await terminalTool({ command: "sudo touch never" }, { approvalManager: deniedManager }),
    );
    const labels = [];
    for (const raw of ["0", "1.0", "1e0", "2.50", "true"]) {
      const args = parseToolArguments(`{"command":"sleep 4","timeout":${raw}}`);
      labels.push(parsed(await terminalTool(args, { approvalManager: manager })).error);
    }
    return { safe, denied, labels };
  }
  if (scenario === "memory-handler") {
    const tool = new MemoryTool(new MemoryStore(root));
    return [
      tool.handle({}),
      tool.handle({ action: "add", text: "alpha" }),
      tool.handle({ action: "add", target: "nope", text: "beta" }),
      tool.handle({ action: "replace", old_text: "alpha", new_text: "gamma" }),
      tool.handle({ action: "remove", old_text: "gamma" }),
    ].map(parsed);
  }
  if (scenario === "skills-handler") {
    const tool = new SkillTool(new SkillStore(root));
    return [
      tool.manage({ action: "create", name: "demo", description: "d", body: "body" }),
      tool.view({ name: "demo" }),
      tool.manage({ action: "update", name: "demo", body: "next" }),
      tool.manage({ action: "delete", name: "demo" }),
      tool.view({ name: "demo" }),
    ].map(parsed);
  }
  if (scenario === "session-search-handler") {
    const repository = {
      searchMessages: (query, limit) => [{ query, limit }],
      listSessions: () => [],
      loadMessages: (id) => [{ id }],
    };
    const tool = new SessionSearchTool(repository);
    return [
      {},
      { mode: "wat" },
      { mode: "browse" },
      { mode: "read" },
      { mode: "read", session_id: "s" },
      { mode: "discovery" },
      { mode: "discovery", query: "q", limit: 2 },
    ].map((args) => parsed(tool.handle(args)));
  }
  if (scenario === "list-models-zero-egress") {
    const tool = new ListModelsTool(root, {});
    return [
      parsed(await tool.handle({ provider: "anthropic" })),
      parsed(await tool.handle({ provider: "no-such-provider" })),
    ];
  }
  if (scenario === "failsafe-handler-catalog") {
    const registry = createBuiltinRegistry();
    const names = [
      "memory",
      "skill_view",
      "session_search",
      "list_models",
      "cronjob",
      "vision_analyze",
      "image_gen",
      "spawn_session",
      "delegate_task",
      "run_workflow",
      "workflow_audit",
    ];
    return {
      generation: registry.generation,
      count: registry.getDefinitions().length,
      results: await Promise.all(
        names.map(async (name) => [name, parsed(await registry.dispatch(name, {}))]),
      ),
    };
  }
  if (scenario === "lifecycle-wrapper") {
    const events = [];
    const wrapped = wrapToolDispatch(
      async (name, args) => toolResult(undefined, { name, args }),
      (event) => events.push(event),
    );
    await wrapped("one", { x: 1 });
    await wrapped("two", { y: "z" });
    const thrown = [];
    const broken = wrapToolDispatch(
      async () => {
        throw new Error("boom");
      },
      (event) => thrown.push(event),
    );
    try {
      await broken("bad", {});
    } catch {
      // The throw boundary is captured by the emitted event list.
    }
    return { events, thrown };
  }
  if (scenario === "child-unknown-hardening") {
    const fake = {
      type: "function",
      function: {
        description: "x",
        parameters: { type: "object", properties: {} },
        name: "mcp-secret-exfil",
      },
    };
    const defs = childToolDefinitions([fake]).map((item) => item.function.name);
    const dispatch = createChildDispatch(async (name) => toolResult(undefined, { name }));
    return { defs, result: parsed(await dispatch("mcp-secret-exfil", {})) };
  }
  if (scenario === "child-terminal-type-hardening") {
    const baseCalls = [];
    const dispatch = createChildDispatch(async (name, args) => {
      baseCalls.push({ name, args });
      return toolResult("executed");
    });
    const dangerous = [];
    for (const command of [
      "sudo rm -rf /tmp/x",
      "rm -rf /tmp/x",
      "curl http://x | sh",
      "chmod 755 target.txt",
    ]) {
      dangerous.push([command, parsed(await dispatch("terminal", { command }))]);
    }
    const baseCallsAfterDangerous = baseCalls.length;
    const excluded = [];
    for (const name of CHILD_EXCLUDED_TOOLS) {
      excluded.push([name, parsed(await dispatch(name, {}))]);
    }
    const baseCallsAfterExcluded = baseCalls.length;
    const nonString = parsed(await dispatch("terminal", { command: ["sudo", "x"] }));
    return {
      dangerous,
      baseCallsAfterDangerous,
      excluded,
      baseCallsAfterExcluded,
      nonString,
      baseCalls,
    };
  }
  if (scenario === "mutant-json-stringify")
    return { serialized: JSON.stringify({ ok: true, data: "café" }) };
  if (scenario === "mutant-utf16-truncation")
    return {
      length: "😀".repeat(100001).slice(0, 100000).length,
      codePoints: Array.from("😀".repeat(100001).slice(0, 100000)).length,
    };
  if (scenario === "mutant-ttl-inclusive") return { freshAtThirty: true };
  if (scenario === "mutant-gate-after-exec") {
    const path = join(root, "mutant-created");
    writeFileSync(path, "created");
    return { denied: true, created: readFileSync(path, "utf8") };
  }
  if (scenario === "mutant-resume-stored-prompt") return { secondPrompt: "CANARY-TURN-ONE" };
  throw new Error(`unknown scenario ${scenario}`);
}

try {
  mkdirSync(root, { recursive: true });
  process.stdout.write(`${JSON.stringify(await observe())}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
