import { randomUUID } from "node:crypto";

import type { SessionRepository } from "../state/index.js";

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

  public constructor(private readonly sessions: SessionRepository) {}

  public createOrResurrect(input: CreateOrResurrectInput): CreateOrResurrectResult {
    const sessionId = input.sessionId ?? randomUUID().replaceAll("-", "");
    const existing = this.sessions.getSession(sessionId);
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

  public list(): readonly Readonly<Record<string, unknown>>[] {
    return this.sessions.listSessions();
  }

  public history(sessionId: string | undefined): readonly Readonly<Record<string, unknown>>[] {
    return this.sessions.loadMessages(sessionId ?? "");
  }

  public interrupt(sessionId: string | undefined): { readonly ok: boolean } {
    if (sessionId === undefined) return { ok: false };
    if (this.sessions.getSession(sessionId) === null) return { ok: false };
    this.armedInterruptLatches.add(sessionId);
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
