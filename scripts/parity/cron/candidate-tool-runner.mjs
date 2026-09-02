#!/usr/bin/env node
// Real process for the [cli-bilateral] `cronjob` tool scenarios (decision
// 10): builds the SAME registry/composeDispatch wiring src/commands/chat.ts
// uses for a real conversation turn (not a bare `new CronTool().handle()`
// call bypassing the registry), then dispatches one `cronjob` call and
// prints the raw envelope string to stdout. Args come in as a JSON blob on
// argv[2] so the harness can drive add/list/remove/pause/resume uniformly.
import { CronStore } from "../../../dist/cron/store.js";
import { CronTool } from "../../../dist/cron/tool.js";
import { createBuiltinRegistry, composeDispatch } from "../../../dist/tools/index.js";
import process from "node:process";

const home = process.env.LOHRA_HOME;
const args = JSON.parse(process.argv[2]);

const registry = createBuiltinRegistry();
const cronTool = new CronTool(new CronStore(home));
const dispatch = composeDispatch(registry.dispatch.bind(registry), {
  cronjob: (toolArgs) => cronTool.handle(toolArgs),
});

const result = await dispatch("cronjob", args);
process.stdout.write(result);
