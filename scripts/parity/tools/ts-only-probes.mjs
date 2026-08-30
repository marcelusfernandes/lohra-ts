#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  ApprovalManager,
  RegistryToolDispatcher,
  ToolRegistry,
  childToolDefinitions,
  createChildDispatch,
  runBounded,
  terminalTool,
  toolResult,
  wrapToolDispatch,
} from "../../../dist/tools/index.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(root, ".probe-evidence", "t09");
const requested = process.argv[2];
const schema = { description: "x", parameters: { type: "object", properties: {} } };
const definition = (name) => ({ type: "function", function: { ...schema, name } });

const probes = {
  "t09-registry-readonly": async () => {
    const registry = new ToolRegistry();
    const source = { description: "before", parameters: { type: "object", properties: {} } };
    registry.register({ name: "x", toolset: "x", schema: source, handler: () => toolResult() });
    source.description = "after";
    const first = registry.getDefinitions();
    try {
      first[0].function.description = "mutated";
    } catch {
      // Frozen definitions must reject mutation.
    }
    const second = registry.getDefinitions();
    return (
      first !== second && Object.isFrozen(first[0]) && second[0].function.description === "before"
    );
  },
  "t09-child-allowlist": async () => {
    const names = [
      "read_file",
      "write_file",
      "terminal",
      "web_fetch",
      "web_search",
      "mcp-secret-exfil",
      "memory",
    ];
    return (
      JSON.stringify(
        childToolDefinitions(names.map(definition)).map((item) => item.function.name),
      ) === JSON.stringify(names.slice(0, 5))
    );
  },
  "t09-child-terminal-type": async () => {
    let called = false;
    const dispatch = createChildDispatch(async () => {
      called = true;
      return toolResult("executed");
    });
    const result = JSON.parse(await dispatch("terminal", { command: ["sudo", "x"] }));
    return (
      !called &&
      result.error === "command was not approved by the user" &&
      Array.isArray(result.command)
    );
  },
  "t09-parallel-cap": async () => {
    let active = 0;
    let peak = 0;
    const values = Array.from({ length: 17 }, (_, index) => index);
    const results = await runBounded(values, 8, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(5);
      active -= 1;
      return value;
    });
    return peak === 8 && results.every((value, index) => value === index);
  },
  "t09-approval-before-spawn": async () => {
    const target = join(process.cwd(), "probe-approval-sentinel");
    rmSync(target, { force: true });
    const manager = new ApprovalManager();
    const result = JSON.parse(
      await terminalTool(
        { command: `echo created > ${target}; sudo true` },
        { approvalManager: manager },
      ),
    );
    return result.error === "command was not approved by the user" && !existsSync(target);
  },
  "t09-lifecycle-throw": async () => {
    const events = [];
    const wrapped = wrapToolDispatch(
      async () => {
        throw new Error("boom");
      },
      (event) => events.push(event),
    );
    let threw = false;
    try {
      await wrapped("bad", { x: 1 });
    } catch {
      threw = true;
    }
    return (
      threw &&
      events.length === 1 &&
      events[0].type === "tool.start" &&
      events[0].payload.args_text === '{"x": 1}'
    );
  },
  "t09-runtime-dispatch-port": async () => {
    const dispatcher = new RegistryToolDispatcher(async (_name, args) =>
      toolResult("café", { count: Object.keys(args).length }),
    );
    const valid = await dispatcher.dispatch({ id: "c1", name: "x", arguments: '{"n":1.0}' });
    const malformed = await dispatcher.dispatch({ id: null, name: "x", arguments: "null" });
    return (
      valid.content === '{"ok": true, "data": "caf\\u00e9", "count": 1}' &&
      malformed.content.endsWith('"count": 0}')
    );
  },
  "t09-stub-default-compat": async () => {
    const executable = join(root, "node_modules", ".bin", "tsx");
    const manifest = join(
      root,
      "scripts",
      "parity",
      "scenarios",
      "t02-chat-tool-read-file-json.json",
    );
    const child = spawnSync(
      executable,
      [join(root, "scripts", "parity", "cli.ts"), "--manifest", manifest],
      { cwd: root, encoding: "utf8", timeout: 90000 },
    );
    return child.status === 0 && child.stdout.includes('"verdict":"match"');
  },
};

const ids = requested ? [requested] : Object.keys(probes);
let failures = 0;
for (const id of ids) {
  const probe = probes[id];
  if (!probe) {
    process.stderr.write(`unknown probe ${id}\n`);
    failures += 1;
    continue;
  }
  let ok = false;
  let cause = null;
  try {
    ok = await probe();
  } catch (error) {
    cause = error?.stack ?? String(error);
    process.stderr.write(`${id}: ${cause}\n`);
  }
  const record = {
    id,
    assertions: [{ name: id, passed: ok }],
    failures: ok ? [] : [cause ?? "probe assertion returned false"],
    verdict: ok ? "match" : "divergent",
  };
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (!ok) failures += 1;
}
process.exitCode = failures === 0 && ids.length > 0 ? 0 : 1;
