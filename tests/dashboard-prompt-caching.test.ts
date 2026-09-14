// Issue #586 (épico #575, 2ª rodada): `dashboard.ts`'s cron `runJob` passes
// the full `SystemPromptSnapshot` (not just `.text`) to
// `ConversationRuntime.promptSnapshot` — this test proves it against a REAL
// `runDashboard` boot with a due cron job, a stub HTTP server speaking the
// Anthropic Messages SSE wire (dashboard always builds its model transports
// with `streaming: true`, see `tests/gateway/dashboard-prompt-contract.
// test.ts`'s own note). The interactive WS path (`createGatewayUpgradeHandler`,
// `src/gateway/ws/connection.ts`, out of this issue's `Files`) is NOT
// reached by this wiring and still only ever gets `.text` — documented gap
// in `docs/system-prompt.md`, not exercised here.
//
// Issue #624: the original assertion pinned `blocks[0]` -- only true
// because `context` is empty in this tmpdir; if anything ever lands in
// `context`, the breakpoint moves to `blocks[1]` with no real regression.
// `assertSingleBreakpointBeforeDateBlock` finds the cached block by
// scanning instead, and pins the invariant that matters: exactly one
// cached block, immediately before the `volatile` band's date.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDashboard, type DashboardCommandOptions } from "../src/commands/dashboard.js";
import { CronStore } from "../src/cron/store.js";
import { registerProvider } from "../src/providers/registry.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

/** Same Anthropic Messages SSE shape `tests/transports-provider-clients.
 * test.ts` already exercises against the client directly — dashboard.ts
 * always builds its transports with `streaming: true`. */
function anthropicSseTurn(text: string): string {
  return [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
    "",
  ].join("\n\n");
}

/** Issue #624: robust replacement for pinning `blocks[0]` -- finds the
 * cache_control breakpoint by scanning (there must be EXACTLY one) and
 * asserts it sits immediately before the block carrying the volatile
 * band's date, wherever that lands once `context` stops being empty. */
function assertSingleBreakpointBeforeDateBlock(blocks: readonly Record<string, unknown>[]): void {
  const cachedIndexes = blocks
    .map((block, index) => (block.cache_control === undefined ? -1 : index))
    .filter((index) => index !== -1);
  expect(cachedIndexes).toHaveLength(1);
  const cachedIndex = cachedIndexes[0] as number;
  const dateBlock = blocks[cachedIndex + 1];
  expect(dateBlock).toBeDefined();
  expect(dateBlock?.cache_control).toBeUndefined();
  expect(String(dateBlock?.text)).toContain("Today's date is");
}

function startCapturingServer(onBody: (body: Readonly<Record<string, unknown>>) => void): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      onBody(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Readonly<Record<string, unknown>>,
      );
      const text = anthropicSseTurn("ok");
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
}

describe("dashboard.ts cron runJob passes the full SystemPromptSnapshot to the Anthropic transport (#586)", () => {
  it("sends system as cache_control blocks for a due cron job's turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t586-dashboard-"));
    roots.push(root);
    const home = join(root, ".lohra");
    const captured: Readonly<Record<string, unknown>>[] = [];
    const server = startCapturingServer((body) => captured.push(body));
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t586-dashboard-anthropic-probe";
      registerProvider({
        name: provider,
        apiMode: "anthropic_messages",
        aliases: [],
        displayName: "T586 dashboard Anthropic probe",
        description: "Local stub for the Anthropic Messages SSE wire (issue #586).",
        signupUrl: "",
        envVars: ["T586_DASH_KEY"],
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        modelsUrl: "",
        requiresApiKey: true,
        supportsVision: false,
        fallbackModels: ["t586-dashboard-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      // A "once" job whose due time is already in the past: `tick()` runs
      // BEFORE the scheduler's first wait, so this fires within the same
      // event-loop turn `runDashboard` finishes booting, no clock injection
      // needed (`src/cron/scheduler.ts`'s own doc comment).
      new CronStore(home).add({
        name: "t586",
        prompt: "say hi",
        type: "once",
        value: Date.now() / 1000 - 10,
      });

      let shutdown: (() => void) | undefined;
      const options: DashboardCommandOptions = {
        flags: new Map([
          ["--provider", provider],
          ["--model", "t586-dashboard-model"],
        ]),
        environment: {
          HOME: root,
          PATH: process.env.PATH ?? "",
          T586_DASH_KEY: "test-key",
        },
        home,
        codexHome: join(root, ".codex"),
        cwd: root,
        stderr: () => undefined,
        port: 0,
        registerShutdownTrigger: (handler) => {
          shutdown = handler;
        },
      };
      const donePromise = runDashboard(options);
      // Poll instead of a single fixed sleep: the tick is async (client
      // construction, HTTP round trip) even though it starts immediately.
      for (let attempt = 0; attempt < 50 && captured.length === 0; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      shutdown?.();
      await donePromise;

      expect(captured.length).toBeGreaterThan(0);
      const system = captured[0]?.system;
      expect(Array.isArray(system)).toBe(true);
      const blocks = system as readonly Record<string, unknown>[];
      // Same distinguishing signal as tests/chat-prompt-caching.test.ts: a
      // flat string collapses to one block; the full snapshot splits stable
      // (cacheable) from volatile (today's date), at least two blocks.
      expect(blocks.length).toBeGreaterThan(1);
      assertSingleBreakpointBeforeDateBlock(blocks);
    } finally {
      await closeServer(server);
    }
  });
});
