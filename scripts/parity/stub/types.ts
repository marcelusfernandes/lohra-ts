import type { StubFixture, StubSpec, StubState } from "../types.js";

export interface StubDriverConfig {
  readonly scenario: string;
  readonly side: "oracle" | "candidate";
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
  posts: number;
  requests: number;
}
