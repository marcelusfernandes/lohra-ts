export type AdapterKind = "python" | "typescript";
export type CaptureRoot = "home" | "profile";
export type ComparisonClass = "byte" | "format" | "schema" | "probe" | "multiprocess" | "stub";

export interface RunnerSpec {
  readonly adapter: AdapterKind;
  readonly executable: string;
  readonly prefixArgs: readonly string[];
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
}

export type SqlitePragma =
  | "application_id"
  | "foreign_keys"
  | "journal_mode"
  | "page_size"
  | "schema_version"
  | "user_version";

export interface EventCaptureSpec {
  readonly name: string;
  readonly root: CaptureRoot;
  readonly path: string;
  readonly format: "json" | "jsonl";
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
    };

export interface OracleGuardSpec {
  readonly expectedCommit: string;
  readonly expectedVersion: string;
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
