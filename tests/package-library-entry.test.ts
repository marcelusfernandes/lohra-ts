import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// This type-only fixture is checked by the standalone `npm run typecheck` gate.
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
  it("types a strict consumer using only published runtime dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-library-types-"));
    try {
      const packageRoot = join(root, "node_modules", "lohra-ts");
      const dist = join(packageRoot, "dist");
      const tsc = resolve("node_modules/typescript/bin/tsc");
      const build = spawnSync(
        process.execPath,
        [tsc, "-p", "tsconfig.build.json", "--outDir", dist],
        { cwd: resolve(), encoding: "utf8", timeout: 120_000, windowsHide: true },
      );
      expect(build.error).toBeUndefined();
      expect(build.status, build.stdout + build.stderr).toBe(0);

      const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      writeFileSync(join(packageRoot, "package.json"), readFileSync(resolve("package.json")));
      for (const dependency of ["better-sqlite3", "@types/better-sqlite3"] as const) {
        if (dependency in manifest.dependencies) {
          const destination = join(root, "node_modules", dependency);
          mkdirSync(resolve(destination, ".."), { recursive: true });
          cpSync(resolve("node_modules", dependency), destination, { recursive: true });
        }
      }
      // Node's declarations are the consumer's own development dependency.
      for (const dependency of ["@types/node", "undici-types"] as const) {
        const destination = join(root, "node_modules", dependency);
        mkdirSync(resolve(destination, ".."), { recursive: true });
        cpSync(resolve("node_modules", dependency), destination, { recursive: true });
      }
      writeFileSync(join(root, "package.json"), '{"type":"module","private":true}');
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            strict: true,
            skipLibCheck: false,
            noEmit: true,
          },
          include: ["consumer.ts"],
        }),
      );
      writeFileSync(
        join(root, "consumer.ts"),
        'import { type StateConnection, type ConversationRuntimeOptions } from "lohra-ts";\n' +
          "declare const connection: StateConnection;\n" +
          "declare const options: ConversationRuntimeOptions;\n" +
          "void connection.database; void options.transport;\n",
      );
      const consumer = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
      expect(consumer.error).toBeUndefined();
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("runs the public composition from a plain JavaScript consumer", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-library-js-"));
    try {
      const source = pathToFileURL(resolve("src/index.ts")).href;
      const databasePath = join(root, "state.db");
      const program = `
        const { ConversationRuntime, SessionRepository, SqliteConversationRepository, openStateDatabase } =
          await import(${JSON.stringify(source)});
        const connection = openStateDatabase(${JSON.stringify(databasePath)});
        try {
          const repository = new SqliteConversationRepository(
            new SessionRepository(connection.database, undefined, connection.ftsEnabled));
          const runtime = new ConversationRuntime({
            repository,
            transport: {
              complete: async () => ({ content: "js reply", finishReason: "stop", toolCalls: [],
                reasoning: null, usage: null, providerData: null }),
              close: () => {},
            },
            promptSnapshot: () => "fixed prompt",
            idSource: () => "js-session",
            clock: () => 1,
            maxIterations: 2,
          });
          const turn = await runtime.runTurn({
            input: "hello", provider: "offline", model: "deterministic", cwd: ${JSON.stringify(root)},
          });
          process.stdout.write(JSON.stringify({
            output: turn.response.content,
            messages: repository.loadMessages(turn.sessionId).length,
          }));
        } finally {
          connection.close();
        }
      `;
      const child = spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", program],
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
      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toEqual({ output: "js reply", messages: 2 });
      expect(existsSync(databasePath)).toBe(true);
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
