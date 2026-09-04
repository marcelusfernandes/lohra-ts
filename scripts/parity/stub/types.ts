import type { StubFixture, StubLaneStep, StubSpec, StubState, StubToolStep } from "../types.js";

export interface StubDriverConfig {
  readonly scenario: string;
  readonly side: "oracle" | "candidate";
  readonly port?: number;
  readonly stub: StubSpec;
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly target: {
    readonly executable: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  };
  readonly logs: {
    readonly projected: string;
    readonly raw: string;
    readonly summary: string;
    readonly assertions: string;
  };
}

export interface StubRuntime {
  readonly fixture: StubFixture;
  readonly state: StubState;
  readonly scenario: string;
  readonly side: "oracle" | "candidate";
  readonly comparedHeaders: readonly string[];
  readonly excludedHeaders: readonly string[];
  readonly projectedLog: string;
  readonly rawLog: string;
  readonly failures: string[];
  readonly sequence: string[];
  readonly toolSequence: readonly StubToolStep[];
  /** T13 lane-script fixture: per-lane step lists (chat-lane-script only —
   * empty for every existing fixture, so this is a no-op elsewhere). */
  laneSteps: Readonly<Record<string, readonly StubLaneStep[]>>;
  /** Mutates independently per lane: which step each lane is on next. Never
   * consulted outside chat-lane-script, so unrelated fixtures never touch
   * it and it never affects their behavior. */
  readonly laneStepIndex: Map<string, number>;
  /** Named one-shot latches backing signal/awaitSignal/gate/openGate — an
   * in-process barrier (the stub and the target run as separate processes,
   * but the stub itself is single-process, so no file-based coordination is
   * needed the way the Python reference implementation required across its
   * own process boundary). */
  readonly latches: Map<string, { readonly promise: Promise<void>; resolve: () => void }>;
  activePort?: number;
  posts: number;
  requests: number;
}
