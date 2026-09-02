import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CronStore } from "../src/cron/store.js";
import { CronTool } from "../src/cron/tool.js";
import { composeDispatch, createBuiltinRegistry } from "../src/tools/index.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lohra-cron-tool-dispatch-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("cronjob — reachable through the real registry/dispatch wiring src/commands/chat.ts uses", () => {
  it("the registry's own fail-safe stub refuses cronjob before interception", async () => {
    const registry = createBuiltinRegistry();
    const result = await registry.dispatch("cronjob", { action: "list" });
    expect(JSON.parse(result)).toEqual({
      error: "the cronjob tool must be intercepted with a session CronStore",
    });
  });

  it("composeDispatch with a session CronTool reaches the real store, same as a conversation turn", async () => {
    const registry = createBuiltinRegistry();
    const cronTool = new CronTool(new CronStore(home));
    const dispatch = composeDispatch(registry.dispatch.bind(registry), {
      cronjob: (args) => cronTool.handle(args),
    });

    const added = JSON.parse(await dispatch("cronjob", { action: "add", name: "n1", prompt: "p1", schedule_type: "interval", value: 5 })) as {
      ok: boolean;
      job_id: string;
    };
    expect(added.ok).toBe(true);
    expect(added.job_id).toMatch(/^[0-9a-f]{32}$/u);

    const listed = JSON.parse(await dispatch("cronjob", { action: "list" })) as { jobs: { id: string }[] };
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0]?.id).toBe(added.job_id);
  });
});
