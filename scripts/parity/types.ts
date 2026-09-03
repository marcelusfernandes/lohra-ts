export type AdapterKind = "python" | "typescript";
export type CaptureRoot = "home" | "profile";
export type ComparisonClass = "byte" | "format" | "schema" | "probe" | "multiprocess" | "stub";

export interface RunnerSpec {
  readonly adapter: AdapterKind;
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly cwd: CaptureRoot | "sandbox";
}

export interface FixtureSpec {
  readonly root: CaptureRoot;
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

export interface TreeCaptureSpec {
  readonly enabled: boolean;
  readonly root: CaptureRoot;
  readonly exclude: readonly string[];
}

export interface SqliteTableSpec {
  readonly name: string;
  readonly orderBy: readonly string[];
}

export interface SqliteCaptureSpec {
  readonly name: string;
  readonly root: CaptureRoot;
  readonly path: string;
  readonly pragmas: readonly SqlitePragma[];
  readonly tables: readonly SqliteTableSpec[];
  readonly projection?: "include" | "raw-only";
}

export type SqlitePragma =
  | "application_id"
  | "encoding"
  | "foreign_keys"
  | "journal_mode"
  | "page_size"
  | "quick_check"
  | "schema_version"
  | "user_version"
  | "wal_autocheckpoint";

export interface EventCaptureSpec {
  readonly name: string;
  readonly root: CaptureRoot;
  readonly path: string;
  readonly format: "json" | "jsonl";
  readonly projection?: "include" | "raw-only";
}

export interface CaptureSpec {
  readonly tree: TreeCaptureSpec;
  readonly sqlite: readonly SqliteCaptureSpec[];
  readonly events: readonly EventCaptureSpec[];
}

export interface ComparisonSpec {
  readonly class: ComparisonClass;
  readonly field: string;
}

export interface ExpectationSpec {
  readonly side: "oracle" | "candidate" | "both";
  readonly field: string;
  readonly value: unknown;
  readonly encoding?: "utf8" | "base64";
  readonly pointer?: string;
  /** Selects nested values; `*` expands one array/object level. */
  readonly pointerPattern?: string;
}

export type NormalizationSpec =
  | {
      readonly field: string;
      readonly kind: "replace-runtime-path";
      readonly source: CaptureRoot;
      readonly replacement: string;
    }
  | {
      readonly field: string;
      readonly kind: "replace-text";
      readonly search: string;
      readonly replacement: string;
    }
  | {
      readonly field: string;
      readonly kind: "replace-json-pointer";
      readonly pointer: string;
      readonly replacement: unknown;
    }
  | {
      readonly field: string;
      readonly kind: "replace-regex";
      readonly pattern: string;
      readonly replacement: string;
      /** When true, this rule is applied AFTER the match/divergent verdict
       * is decided — it only stabilizes the STORED/HASHED projection
       * against volatile-but-legitimately-identical content (e.g. today's
       * date), and never masks a genuine oracle/candidate divergence in
       * that same content from the comparator. Every other normalization
       * kind still applies before comparison, same as before — this only
       * exists for content that's supposed to be equal, where a mismatch
       * IS the bug signal. */
      readonly hashOnly?: boolean;
    };

export interface OracleGuardSpec {
  readonly expectedCommit: string;
  readonly expectedVersion: string;
  readonly expectedPythonVersion?: string;
  readonly expectedPackages?: Readonly<Record<string, string>>;
}

export type StubState = "down" | "up-with-models" | "up-empty-models";
export type StubFixture =
  | "doctor"
  | "chat-text"
  | "chat-del"
  | "chat-stream"
  | "chat-stream-nodone"
  | "chat-stream-options-400"
  | "chat-tool"
  | "chat-tool-stream"
  | "chat-tool-unknown"
  | "chat-http-401"
  | "chat-http-500"
  | "chat-no-usage"
  | "chat-incomplete-tool"
  | "chat-tool-sequence"
  | "side-divergent"
  | "chat-lane-script";

export interface StubToolCall {
  readonly name: string;
  readonly argumentsRaw: string;
  readonly expectedResult: string;
  readonly validation: "exact" | "skip";
}

export interface StubToolStep {
  readonly calls: readonly StubToolCall[];
}

/**
 * One scripted response for one lane under the "chat-lane-script" fixture
 * (T13: multi-conversation orchestration scenarios — a parent turn and one
 * or more concurrently-running children on the same stub). Lanes are
 * discriminated purely from what the product already emits (see
 * scripts/parity/stub/server.ts's laneOf/isChildRequest): a "SCEN:<name>"
 * token the test author put in whatever prompt text reaches that
 * conversation, forwarded unmodified by the product like any other prompt —
 * never a header, field, or param the candidate has to emit specially.
 *
 * signal/awaitSignal/gate/openGate force cross-lane ordering by barrier,
 * never by sleep/delay: a step can declare signal (fires a named latch on
 * arrival, before responding) or awaitSignal/gate (blocks on a named latch
 * another lane's step fires/opens) so a scenario can assert "N requests
 * arrived before this gate opened" without any wall-clock dependency.
 */
export interface StubLaneToolCall {
  readonly name: string;
  readonly argumentsRaw: string;
}
export interface StubLaneStep {
  readonly kind: "text" | "tool_calls" | "http_error";
  readonly content?: string;
  readonly calls?: readonly StubLaneToolCall[];
  readonly status?: number;
  readonly message?: string;
  /** Extra response headers for an http_error step (e.g. "retry-after") — never
   * set for text/tool_calls steps, which always use the fixed content-type/
   * content-length pair the fixture already emits. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: string;
  readonly awaitSignal?: string;
  readonly gate?: string;
  readonly openGate?: string;
}

export interface StubSpec {
  readonly state: StubState;
  readonly fixture: StubFixture;
  readonly requestLog: {
    readonly comparedHeaders: readonly string[];
    readonly excludedHeaders: readonly string[];
  };
  readonly toolSequence?: readonly StubToolStep[];
  readonly laneSteps?: Readonly<Record<string, readonly StubLaneStep[]>>;
}

export interface TcpPortClosedPrecondition {
  readonly kind: "tcp-port-closed";
  readonly host: "127.0.0.1";
  readonly port: number;
}

export type PreconditionSpec = TcpPortClosedPrecondition;

export interface PreconditionRecord extends TcpPortClosedPrecondition {
  readonly status: "passed";
}

export interface ScrubSpec {
  readonly fixtureTokens: boolean;
  readonly operatorCredentials: boolean;
}

export interface ScenarioManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly description: string;
  readonly argv: readonly string[];
  readonly environment: {
    readonly allow: readonly string[];
    readonly set: Readonly<Record<string, string>>;
  };
  readonly preconditions: readonly PreconditionSpec[];
  readonly fixtures: readonly FixtureSpec[];
  readonly runners: {
    readonly oracle: RunnerSpec;
    readonly candidate: RunnerSpec;
  };
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly capture: CaptureSpec;
  readonly comparisons: readonly ComparisonSpec[];
  readonly expectations: readonly ExpectationSpec[];
  readonly normalizations: readonly NormalizationSpec[];
  readonly scrub?: ScrubSpec;
  readonly stub?: StubSpec;
  readonly oracleGuard?: OracleGuardSpec;
}

export interface ProcessRecord {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type SqliteValue =
  | null
  | string
  | { readonly type: "integer"; readonly decimal: string }
  | { readonly type: "real"; readonly value: number }
  | { readonly type: "blob"; readonly base64: string };

export type TreeEntry =
  | { readonly path: string; readonly type: "directory" }
  | { readonly path: string; readonly type: "symlink"; readonly target: string }
  | {
      readonly path: string;
      readonly type: "file";
      readonly mode: string;
      readonly size: number;
      readonly sha256: string;
    };

export interface SqliteRecord {
  readonly exists: boolean;
  readonly schema?: readonly Record<string, unknown>[];
  readonly pragmas?: Readonly<Record<string, SqliteValue>>;
  readonly tables?: Readonly<
    Record<
      string,
      {
        readonly columns: readonly string[];
        readonly rows: readonly (readonly SqliteValue[])[];
      }
    >
  >;
}

export interface EventRecord {
  readonly exists: boolean;
  readonly records?: unknown;
}

export interface RunRecord {
  readonly process: ProcessRecord;
  readonly tree: readonly TreeEntry[];
  readonly sqlite: Readonly<Record<string, SqliteRecord>>;
  readonly events: Readonly<Record<string, EventRecord>>;
}

export interface RuntimePaths {
  readonly root: string;
  readonly home: string;
  readonly profile: string;
  readonly sandbox: string;
}

export interface Difference {
  readonly field: string;
  readonly class: ComparisonClass;
  readonly oracle: unknown;
  readonly candidate: unknown;
}

export interface ComparisonResult {
  readonly verdict: "match" | "divergent";
  readonly differences: readonly Difference[];
  readonly normalized: Readonly<
    Record<string, { readonly oracle: unknown; readonly candidate: unknown }>
  >;
}

export interface GuardRecord {
  readonly commit: string;
  readonly version: string;
  readonly cleanBefore: true;
  readonly cleanAfter: true;
  readonly pythonVersion?: string;
  readonly packages?: Readonly<Record<string, string>>;
}

export interface EvidenceRecord {
  readonly schemaVersion: 1;
  readonly scenario: { readonly id: string; readonly manifestSha256: string };
  readonly commands: {
    readonly oracle: { readonly executable: string; readonly argv: readonly string[] };
    readonly candidate: { readonly executable: string; readonly argv: readonly string[] };
  };
  readonly capturePolicy: CaptureSpec;
  readonly expectationPolicy: readonly ExpectationSpec[];
  readonly normalizationPolicy: readonly NormalizationSpec[];
  readonly scrubPolicy?: ScrubSpec;
  readonly stubPolicy?: StubSpec;
  readonly preconditionPolicy: readonly PreconditionSpec[];
  readonly preconditions: readonly PreconditionRecord[];
  readonly oracleGuard?: GuardRecord;
  readonly runs: { readonly oracle: RunRecord; readonly candidate: RunRecord };
  readonly comparison: ComparisonResult;
  readonly expectations: {
    readonly failures: readonly {
      readonly side: "oracle" | "candidate";
      readonly field: string;
      readonly expected: unknown;
      readonly actual: unknown;
    }[];
  };
  readonly reproducibility: {
    readonly excludedRawPointers: readonly string[];
    readonly projectionSha256: string;
  };
  readonly verdict: "match" | "divergent";
}
