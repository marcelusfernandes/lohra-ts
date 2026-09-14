// Issue #649 (sub-issue B1 de #637): `resolveTurnSession` absorve o ramo
// inteiro que `ConversationRuntime.runTurn` (`src/conversation/runtime.ts`)
// usava para resolver a sessão do turno — sessão nova (`promptSnapshot()` +
// `createSession` com as três faixas), sessão explícita ausente
// (`SESSION_NOT_FOUND`) e sessão retomada (as faixas persistidas, byte-
// idênticas, quando `volatile !== ""`; `promptSnapshot()` de novo só na
// forma migrada, `context === "" && volatile === ""`). Extraído para módulo
// irmão (`runtime-session.ts`) porque `runtime.ts` estava em 796/800 linhas
// — ver `docs/decisions/2026-09-14-faixas-restauradas.md`.
import { describe, expect, it } from "vitest";

import { ConversationError } from "../src/conversation/errors.js";
import { resolveTurnSession } from "../src/conversation/index.js";
import type { ConversationRepository, StoredSession } from "../src/conversation/index.js";
import type { SystemBands } from "../src/transports/index.js";

class MemoryRepository implements ConversationRepository {
  readonly created: { readonly id: string; readonly systemPrompt: string | SystemBands }[] = [];
  private readonly sessions = new Map<string, StoredSession>();

  seed(id: string, session: StoredSession): void {
    this.sessions.set(id, session);
  }

  createSession(input: {
    readonly id: string;
    readonly systemPrompt: string | SystemBands;
    readonly model: string;
    readonly cwd: string;
  }): void {
    this.created.push({ id: input.id, systemPrompt: input.systemPrompt });
    this.sessions.set(input.id, {
      systemPrompt: input.systemPrompt,
      model: input.model,
      cwd: input.cwd,
    });
  }

  session(id: string): StoredSession | null {
    return this.sessions.get(id) ?? null;
  }

  loadMessages(): readonly Readonly<Record<string, unknown>>[] {
    return [];
  }

  commitTurn(): void {
    // unused in this test
  }

  commitUsage(): void {
    // unused in this test
  }

  summary(): null {
    return null;
  }
}

const bandsA: SystemBands = { stable: "STABLE A", context: "CONTEXT A", volatile: "VOLATILE A" };
const bandsB: SystemBands = { stable: "STABLE B", context: "CONTEXT B", volatile: "VOLATILE B" };

describe("resolveTurnSession (#649)", () => {
  it("creates a fresh session from promptSnapshot() and persists the bands via createSession", () => {
    const repository = new MemoryRepository();
    const result = resolveTurnSession({
      repository,
      sessionId: undefined,
      idSource: () => "generated-id",
      promptSnapshot: () => bandsA,
      model: "m",
      cwd: "/tmp",
    });

    expect(result.sessionId).toBe("generated-id");
    expect(result.created).toBe(true);
    expect(result.session).toEqual({ systemPrompt: bandsA, model: "m", cwd: "/tmp" });
    expect(repository.created).toEqual([{ id: "generated-id", systemPrompt: bandsA }]);
  });

  it("throws SESSION_NOT_FOUND when an explicit sessionId doesn't resolve", () => {
    const repository = new MemoryRepository();
    let caught: unknown;
    try {
      resolveTurnSession({
        repository,
        sessionId: "missing",
        idSource: () => {
          throw new Error("idSource must not be called when sessionId is explicit");
        },
        promptSnapshot: () => bandsA,
        model: "m",
        cwd: "/tmp",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConversationError);
    expect((caught as ConversationError).code).toBe("SESSION_NOT_FOUND");
    expect((caught as ConversationError).sessionId).toBe("missing");
    expect(repository.created).toEqual([]);
  });

  it("never throws for an auto-generated id that happens to already exist (only an EXPLICIT id can 404)", () => {
    const repository = new MemoryRepository();
    repository.seed("generated-id", { systemPrompt: bandsA, model: "m", cwd: "/tmp" });
    const result = resolveTurnSession({
      repository,
      sessionId: undefined,
      idSource: () => "generated-id",
      promptSnapshot: () => bandsB,
      model: "m",
      cwd: "/tmp",
    });
    expect(result.created).toBe(false);
    expect(result.session.systemPrompt).toEqual(bandsA);
  });

  it("reuses the persisted bands byte-identical for a resumed session (invariant 1) — never calls promptSnapshot()", () => {
    const repository = new MemoryRepository();
    repository.seed("s1", { systemPrompt: bandsA, model: "m", cwd: "/tmp" });
    let promptSnapshotCalls = 0;
    const result = resolveTurnSession({
      repository,
      sessionId: "s1",
      idSource: () => {
        throw new Error("idSource must not be called for an explicit sessionId");
      },
      promptSnapshot: () => {
        promptSnapshotCalls += 1;
        return bandsB;
      },
      model: "m",
      cwd: "/tmp",
    });

    expect(result.created).toBe(false);
    expect(result.session).toEqual({ systemPrompt: bandsA, model: "m", cwd: "/tmp" });
    expect(promptSnapshotCalls).toBe(0);
  });

  it("falls back to promptSnapshot() for a migrated row (context and volatile both empty)", () => {
    const repository = new MemoryRepository();
    const migrated: string | SystemBands = { stable: "OLD FLAT PROMPT", context: "", volatile: "" };
    repository.seed("s1", { systemPrompt: migrated, model: "m", cwd: "/tmp" });
    const result = resolveTurnSession({
      repository,
      sessionId: "s1",
      idSource: () => {
        throw new Error("idSource must not be called for an explicit sessionId");
      },
      promptSnapshot: () => bandsB,
      model: "m",
      cwd: "/tmp",
    });

    expect(result.created).toBe(false);
    expect(result.session.systemPrompt).toEqual(bandsB);
  });

  it("falls back to promptSnapshot() for a resumed session with a plain-string systemPrompt (pre-#586 caller)", () => {
    const repository = new MemoryRepository();
    repository.seed("s1", { systemPrompt: "FLAT SYSTEM TEXT", model: "m", cwd: "/tmp" });
    const result = resolveTurnSession({
      repository,
      sessionId: "s1",
      idSource: () => {
        throw new Error("idSource must not be called for an explicit sessionId");
      },
      promptSnapshot: () => bandsB,
      model: "m",
      cwd: "/tmp",
    });

    expect(result.created).toBe(false);
    expect(result.session.systemPrompt).toEqual(bandsB);
  });
});
