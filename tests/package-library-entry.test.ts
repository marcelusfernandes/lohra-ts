import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  ConversationRepository,
  ConversationRuntimeEvent,
  ConversationRuntimeOptions,
  ConversationTurnResult,
  ModelRequest,
  ModelTransport,
  NormalizedResponse,
  StateConnection,
  SystemBands,
  ToolDispatcher,
} from "../src/index.js";

// This type-only fixture is checked by `typecheck` in the proof declaration.
type PublicPorts = readonly [
  ConversationRepository,
  ConversationRuntimeOptions,
  ModelRequest,
  ToolDispatcher,
  SystemBands,
  StateConnection,
];
const publicPortsAreTyped = (_ports: PublicPorts): void => {};
void publicPortsAreTyped;

describe("package library entry", () => {
  it("exposes only the deliberate runtime and state values", async () => {
    const entry = await import("../src/index.js");
    expect(Object.keys(entry).sort()).toEqual([
      "ConversationRuntime",
      "SessionRepository",
      "SqliteConversationRepository",
      "openStateDatabase",
    ]);
  });

  it("runs a deterministic offline turn through the public SQLite composition", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-library-turn-"));
    try {
      const {
        ConversationRuntime,
        SessionRepository,
        SqliteConversationRepository,
        openStateDatabase,
      } = await import("../src/index.js");
      const connection = openStateDatabase(join(root, "state.db"));
      try {
        const repository = new SqliteConversationRepository(
          new SessionRepository(connection.database, undefined, connection.ftsEnabled),
        );
        const requests: ModelRequest[] = [];
        const response: NormalizedResponse = {
          content: "offline reply",
          finishReason: "stop",
          toolCalls: [],
          reasoning: null,
          usage: null,
          providerData: null,
        };
        const transport: ModelTransport = {
          complete: (request) => {
            requests.push(request);
            return Promise.resolve(response);
          },
          close: () => {},
        };
        const events: ConversationRuntimeEvent[] = [];
        const runtime = new ConversationRuntime({
          repository,
          transport,
          promptSnapshot: () => "fixed prompt",
          eventSink: (event) => events.push(event),
          idSource: () => "public-session",
          clock: () => 1,
          maxIterations: 2,
        });
        const turn: ConversationTurnResult = await runtime.runTurn({
          input: "hello",
          provider: "offline",
          model: "deterministic",
          cwd: root,
        });
        expect(turn.sessionId).toBe("public-session");
        expect(turn.response.content).toBe("offline reply");
        expect(requests).toHaveLength(1);
        expect(repository.loadMessages(turn.sessionId)).toHaveLength(2);
        expect(events.map((event) => event.type)).toEqual([
          "turn.started",
          "model.request.started",
          "model.request.completed",
          "turn.completed",
        ]);
      } finally {
        connection.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports without creating a home, starting CLI/provider, or printing", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-library-import-"));
    try {
      const source = pathToFileURL(resolve("src/index.ts")).href;
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(source)})`,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            LOHRA_HOME: join(root, "lohra"),
            CODEX_HOME: join(root, "codex"),
          },
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("");
      expect(child.stderr).toBe("");
      expect(existsSync(join(root, "lohra"))).toBe(false);
      expect(existsSync(join(root, "state.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
