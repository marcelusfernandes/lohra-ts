export const PROTOCOL_VERSION = 1;
export const MAX_METADATA_BYTES = 1_048_576;
export const MAX_OUTPUT_BYTES = 67_108_864;
export const MAX_FRAME_BYTES = MAX_METADATA_BYTES + 2 * MAX_OUTPUT_BYTES;

export interface HelperRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: readonly (readonly [string, string])[];
  readonly timeoutMs: number;
  readonly cleanupMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
}

export type HelperOutcome =
  | "exited"
  | "timeout"
  | "overflow"
  | "spawn-error"
  | "api-error"
  | "protocol-error"
  | "containment-error";

export interface HelperResult {
  readonly outcome: HelperOutcome;
  readonly pid: number | null;
  readonly status: number | null;
  readonly containmentConfirmed: boolean;
  readonly faultCode: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export class ProtocolError extends Error {
  constructor(readonly code: string) {
    super(`NPM_HELPER_PROTOCOL:${code}`);
  }
}

export function encodeRequest(_request: HelperRequest): Uint8Array {
  throw new Error("not implemented");
}

export function decodeRequest(_frame: Uint8Array): HelperRequest {
  throw new Error("not implemented");
}

export function encodeResult(_result: HelperResult): Uint8Array {
  throw new Error("not implemented");
}

export function decodeResult(_frame: Uint8Array): HelperResult {
  throw new Error("not implemented");
}
