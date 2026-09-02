import { randomUUID } from "node:crypto";

import type { SessionRepository } from "../state/index.js";
import { nullableInteger } from "../state/values.js";

const GATEWAY_VERSION = "0.0.11";

export interface CreateOrResurrectInput {
  readonly sessionId?: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly cwd: string;
}

export interface CreateOrResurrectResult {
  readonly sessionId: string;
  readonly created: boolean;
}

export interface GatewaySessionInfo {
  readonly model: string;
  readonly tools: readonly string[];
  readonly running: boolean;
  readonly version: string;
}

// Wraps SessionRepository with the gateway-specific concepts the oracle's
// GatewaySession/SessionManager own that have no equivalent in the shared
// state layer: session.create idempotency (including resurrecting a
// compaction-dead parent -- ADR-T12-04, create_session() never consults
// end_reason), the busy flag, and the one-shot interrupt latch.
export class GatewaySessionRegistry {
  private readonly busySessions = new Set<string>();
  private readonly armedInterruptLatches = new Set<string>();
  private readonly activeTurnControllers = new Map<string, AbortController>();
  // Models the oracle's SessionManager in-memory cache, which is distinct
  // from the DB row: SessionManager.get() (the path prompt.submit uses)
  // refuses a session whose DB row has end_reason=="compression" UNLESS
  // it's already in the cache -- and create_session() populates the cache
  // without ever consulting end_reason, which is exactly the mechanism
  // that makes resurrection work (ADR-T12-04, L18). A dead parent this
  // gateway process has never seen via session.create stays refused for
  // prompt.submit; the moment session.create touches it (fresh id or
  // resurrection), it's usable for the rest of this process's lifetime.
  private readonly knownSessionIds = new Set<string>();

  public constructor(private readonly sessions: SessionRepository) {}

  public createOrResurrect(input: CreateOrResurrectInput): CreateOrResurrectResult {
    const sessionId = input.sessionId ?? randomUUID().replaceAll("-", "");
    const existing = this.sessions.getSession(sessionId);
    this.knownSessionIds.add(sessionId);
    if (existing !== null) return { sessionId, created: false };
    this.sessions.createSession({
      id: sessionId,
      source: "gateway",
      model: input.model,
      systemPrompt: input.systemPrompt,
      cwd: input.cwd,
    });
    return { sessionId, created: true };
  }

  // The check prompt.submit uses: known-to-this-process sessions (via
  // session.create, resurrection included) are always submittable; a
  // session this process has never touched is submittable only if its DB
  // row exists and is not a dead (compressed) parent -- lazily joining the
  // cache the first time it's found submittable, matching a real
  // SessionManager.get() cache-fill on first successful lookup.
  public canSubmitPrompt(sessionId: string): boolean {
    if (this.knownSessionIds.has(sessionId)) return true;
    const row = this.sessions.getSession(sessionId);
    if (row === null || row.end_reason === "compression") return false;
    this.knownSessionIds.add(sessionId);
    return true;
  }

  public list(): readonly Readonly<Record<string, unknown>>[] {
    // listSessions() runs against a defaultSafeIntegers(true) connection
    // (src/state/connection.ts), so message_count (an INTEGER column)
    // comes back as bigint -- JSON.stringify (and jsonStringifyPythonNumbers)
    // cannot serialize bigint at all. started_at/ended_at are REAL columns
    // and are unaffected. Normalize before this ever reaches the wire.
    return this.sessions.listSessions().map((row) => ({
      ...row,
      message_count: nullableInteger(row.message_count as bigint | number | null, "message_count"),
    }));
  }

  public history(sessionId: string | undefined): readonly Readonly<Record<string, unknown>>[] {
    return this.sessions.loadMessages(sessionId ?? "");
  }

  // Idle session -> arm the one-shot latch a subsequent prompt.submit
  // consumes. Busy session (a turn is actively running, possibly on a
  // DIFFERENT socket -- interrupt is explicitly cross-socket, L19) -> abort
  // that turn's controller, which ConversationRuntime.runTurn checks at the
  // top of its next iteration and turns into ConversationCancelledError.
  // Either way the RPC response is {ok:true} immediately (L16).
  public interrupt(sessionId: string | undefined): { readonly ok: boolean } {
    if (sessionId === undefined) return { ok: false };
    if (this.sessions.getSession(sessionId) === null) return { ok: false };
    const activeController = this.activeTurnControllers.get(sessionId);
    if (activeController !== undefined) activeController.abort();
    else this.armedInterruptLatches.add(sessionId);
    return { ok: true };
  }

  public consumeInterruptLatch(sessionId: string): boolean {
    const armed = this.armedInterruptLatches.has(sessionId);
    this.armedInterruptLatches.delete(sessionId);
    return armed;
  }

  public isBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  public markBusy(sessionId: string): void {
    this.busySessions.add(sessionId);
  }

  public clearBusy(sessionId: string): void {
    this.busySessions.delete(sessionId);
  }

  // Registers the AbortController driving sessionId's current turn so a
  // session.interrupt arriving on ANY socket (including a different one)
  // can reach it. Callers must also call markBusy/clearBusy around the
  // same turn -- beginTurn does not do that itself, since the caller
  // controls exactly when "busy" starts (after the idle-latch check) versus
  // when the controller needs to exist.
  public beginTurn(sessionId: string): AbortController {
    const controller = new AbortController();
    this.activeTurnControllers.set(sessionId, controller);
    return controller;
  }

  public endTurn(sessionId: string): void {
    this.activeTurnControllers.delete(sessionId);
  }

  public sessionInfo(input: {
    readonly model: string;
    readonly tools: readonly string[];
    readonly running: boolean;
  }): GatewaySessionInfo {
    return {
      model: input.model,
      tools: input.tools,
      running: input.running,
      version: GATEWAY_VERSION,
    };
  }
}
