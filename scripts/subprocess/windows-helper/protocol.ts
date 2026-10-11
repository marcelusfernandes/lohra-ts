/** Version 1 uses little-endian unsigned integers and length-prefixed UTF-8. */
export const PROTOCOL_VERSION = 1;
export const MAX_METADATA_BYTES = 1_048_576;
export const MAX_OUTPUT_BYTES = 67_108_864;
export const MAX_FRAME_BYTES = 9 + MAX_METADATA_BYTES + 2 * MAX_OUTPUT_BYTES;
export const MAX_STRING_BYTES = 16_384;
export const MAX_ARGV_COUNT = 1_024;
export const MAX_ENV_COUNT = 512;
export const MAX_TIMEOUT_MS = 86_400_000;
export const MAX_CLEANUP_MS = 60_000;

const HEADER_BYTES = 9;
const REQUEST_KIND = 1;
const RESULT_KIND = 2;
const outcomes = [
  "exited",
  "timeout",
  "overflow",
  "spawn-error",
  "api-error",
  "protocol-error",
  "containment-error",
] as const;
const phases = ["launch", "run", "cleanup", "protocol"] as const;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface HelperRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: readonly (readonly [string, string])[];
  /** Zero means no execution deadline. */
  readonly timeoutMs: number;
  readonly cleanupMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
}
export type HelperOutcome = (typeof outcomes)[number];
export type FaultPhase = (typeof phases)[number];
export interface HelperFault {
  readonly phase: FaultPhase;
  readonly code: string;
  readonly nativeCode: number | null;
}
export interface HelperResult {
  readonly outcome: HelperOutcome;
  readonly pid: number | null;
  readonly status: number | null;
  readonly containmentConfirmed: boolean;
  readonly fault: HelperFault | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}
export class ProtocolError extends Error {
  constructor(readonly code: string) {
    super(`NPM_HELPER_PROTOCOL:${code}`);
  }
}
function fail(code: string): never {
  throw new ProtocolError(code);
}
function uint(value: number, max: number, code = "LIMIT"): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(code);
  return value;
}
function utf8(value: string, native = true): Uint8Array {
  if (typeof value !== "string") fail("TYPE");
  if (native && value.includes("\0")) fail("NUL");
  if (value.length > MAX_STRING_BYTES) fail("LENGTH");
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("UTF8");
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("UTF8");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > MAX_STRING_BYTES) fail("LENGTH");
  return bytes;
}
class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  constructor(private readonly cap: number) {}
  add(bytes: Uint8Array): void {
    if (bytes.length > this.cap - this.length) fail("LENGTH");
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  u8(value: number): void {
    this.add(Uint8Array.of(uint(value, 255)));
  }
  u32(value: number): void {
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeUInt32LE(uint(value, 0xffff_ffff));
    this.add(bytes);
  }
  string(value: string, native = true): void {
    const bytes = utf8(value, native);
    this.u32(bytes.length);
    this.add(bytes);
  }
  bytes(value: Uint8Array): void {
    if (!(value instanceof Uint8Array)) fail("TYPE");
    if (value.byteLength > MAX_OUTPUT_BYTES) fail("OUTPUT");
    this.u32(value.byteLength);
    this.add(value);
  }
  frame(kind: number): Uint8Array {
    const frame = Buffer.allocUnsafe(HEADER_BYTES + this.length);
    frame.write("LNP", 0, "ascii");
    frame[3] = PROTOCOL_VERSION;
    frame[4] = kind;
    frame.writeUInt32LE(this.length, 5);
    let offset = HEADER_BYTES;
    for (const chunk of this.chunks) {
      frame.set(chunk, offset);
      offset += chunk.length;
    }
    return frame;
  }
}
class Reader {
  private offset = HEADER_BYTES;
  constructor(private readonly frame: Uint8Array) {}
  take(length: number): Uint8Array {
    if (length > this.frame.length - this.offset) fail("TRUNCATED");
    const bytes = this.frame.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
  u8(): number {
    return this.take(1)[0] ?? fail("TRUNCATED");
  }
  u32(): number {
    const bytes = this.take(4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }
  string(native = true): string {
    const length = this.u32();
    if (length > MAX_STRING_BYTES) fail("LENGTH");
    let value: string;
    try {
      value = decoder.decode(this.take(length));
    } catch {
      return fail("UTF8");
    }
    if (native && value.includes("\0")) fail("NUL");
    return value;
  }
  bytes(): Uint8Array {
    const length = this.u32();
    if (length > MAX_OUTPUT_BYTES) fail("OUTPUT");
    return Uint8Array.from(this.take(length));
  }
  done(): void {
    if (this.offset !== this.frame.length) fail("EXTRA");
  }
}
function readFrame(frame: Uint8Array, kind: number, cap: number): Reader {
  if (!(frame instanceof Uint8Array)) fail("TYPE");
  if (frame.length < HEADER_BYTES) fail("TRUNCATED");
  if (frame[0] !== 76 || frame[1] !== 78 || frame[2] !== 80 || frame[3] !== PROTOCOL_VERSION)
    fail("VERSION");
  if (frame[4] !== kind) fail("KIND");
  const size = new DataView(frame.buffer, frame.byteOffset + 5, 4).getUint32(0, true);
  if (size > cap) fail("LENGTH");
  if (size > frame.length - HEADER_BYTES) fail("TRUNCATED");
  if (size < frame.length - HEADER_BYTES) fail("EXTRA");
  return new Reader(frame);
}
function validateRequest(value: HelperRequest): void {
  const candidate: unknown = value;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Array.isArray(value.argv) ||
    !Array.isArray(value.env)
  )
    fail("TYPE");
  if (value.argv.length > MAX_ARGV_COUNT || value.env.length > MAX_ENV_COUNT) fail("COUNT");
  if (
    typeof value.executable !== "string" ||
    typeof value.cwd !== "string" ||
    !value.executable ||
    !value.cwd
  )
    fail("LENGTH");
  uint(value.timeoutMs, MAX_TIMEOUT_MS);
  uint(value.cleanupMs, MAX_CLEANUP_MS);
  if (value.cleanupMs === 0) fail("LIMIT");
  uint(value.stdoutLimitBytes, MAX_OUTPUT_BYTES);
  uint(value.stderrLimitBytes, MAX_OUTPUT_BYTES);
  for (const pair of value.env) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      !pair[0] ||
      pair[0].includes("=")
    )
      fail("ENV");
  }
}
export function encodeRequest(value: HelperRequest): Uint8Array {
  validateRequest(value);
  const out = new Writer(MAX_METADATA_BYTES);
  out.string(value.executable);
  out.string(value.cwd);
  out.u32(value.argv.length);
  for (const arg of value.argv) out.string(arg);
  out.u32(value.env.length);
  for (const [key, entry] of value.env) {
    out.string(key);
    out.string(entry);
  }
  out.u32(value.timeoutMs);
  out.u32(value.cleanupMs);
  out.u32(value.stdoutLimitBytes);
  out.u32(value.stderrLimitBytes);
  return out.frame(REQUEST_KIND);
}
export function decodeRequest(frame: Uint8Array): HelperRequest {
  const input = readFrame(frame, REQUEST_KIND, MAX_METADATA_BYTES);
  const executable = input.string();
  const cwd = input.string();
  const argc = input.u32();
  if (argc > MAX_ARGV_COUNT) fail("COUNT");
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) argv.push(input.string());
  const envc = input.u32();
  if (envc > MAX_ENV_COUNT) fail("COUNT");
  const env: [string, string][] = [];
  for (let i = 0; i < envc; i++) env.push([input.string(), input.string()]);
  const value: HelperRequest = {
    executable,
    argv,
    cwd,
    env,
    timeoutMs: input.u32(),
    cleanupMs: input.u32(),
    stdoutLimitBytes: input.u32(),
    stderrLimitBytes: input.u32(),
  };
  input.done();
  validateRequest(value);
  return value;
}
function validateResult(value: HelperResult): number {
  const candidate: unknown = value;
  if (candidate === null || typeof candidate !== "object") fail("TYPE");
  const index = outcomes.indexOf(value.outcome);
  if (index < 0) fail("OUTCOME");
  if (value.pid !== null) uint(value.pid, 0xffff_ffff, "PID");
  if (value.status !== null) uint(value.status, 0xffff_ffff, "STATUS");
  if (typeof value.containmentConfirmed !== "boolean") fail("CONTAINMENT");
  if (value.outcome === "exited") {
    if (!value.containmentConfirmed) fail("CONTAINMENT");
    if (value.pid === null) fail("PID");
    if (value.status === null) fail("STATUS");
    if (value.fault !== null) fail("FAULT");
  } else {
    if (value.status !== null) fail("STATUS");
    if (
      value.outcome === "containment-error"
        ? value.containmentConfirmed
        : !value.containmentConfirmed
    )
      fail("CONTAINMENT");
    if (
      !value.fault ||
      !phases.includes(value.fault.phase) ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.fault.code)
    )
      fail("FAULT");
    if (value.fault.nativeCode !== null) uint(value.fault.nativeCode, 0xffff_ffff, "FAULT");
  }
  if (!(value.stdout instanceof Uint8Array) || !(value.stderr instanceof Uint8Array)) fail("TYPE");
  if (value.stdout.byteLength > MAX_OUTPUT_BYTES || value.stderr.byteLength > MAX_OUTPUT_BYTES)
    fail("OUTPUT");
  return index;
}
export function encodeResult(value: HelperResult): Uint8Array {
  const index = validateResult(value);
  const out = new Writer(MAX_FRAME_BYTES - HEADER_BYTES);
  out.u8(index);
  const flags =
    (value.pid !== null ? 1 : 0) |
    (value.status !== null ? 2 : 0) |
    (value.containmentConfirmed ? 4 : 0) |
    (value.fault?.nativeCode != null ? 8 : 0);
  out.u8(flags);
  if (value.pid !== null) out.u32(value.pid);
  if (value.status !== null) out.u32(value.status);
  if (value.fault) {
    out.u8(phases.indexOf(value.fault.phase));
    out.string(value.fault.code, false);
    if (value.fault.nativeCode !== null) out.u32(value.fault.nativeCode);
  }
  out.bytes(value.stdout);
  out.bytes(value.stderr);
  return out.frame(RESULT_KIND);
}
export function decodeResult(frame: Uint8Array): HelperResult {
  const input = readFrame(frame, RESULT_KIND, MAX_FRAME_BYTES - HEADER_BYTES);
  const outcome = outcomes[input.u8()] ?? fail("OUTCOME");
  const flags = input.u8();
  if (flags & ~15) fail("FLAGS");
  const pid = flags & 1 ? input.u32() : null;
  const status = flags & 2 ? input.u32() : null;
  const containmentConfirmed = Boolean(flags & 4);
  let fault: HelperFault | null = null;
  if (outcome !== "exited") {
    const phase = phases[input.u8()] ?? fail("FAULT");
    const code = input.string(false);
    fault = { phase, code, nativeCode: flags & 8 ? input.u32() : null };
  } else if (flags & 8) fail("FLAGS");
  const value: HelperResult = {
    outcome,
    pid,
    status,
    containmentConfirmed,
    fault,
    stdout: input.bytes(),
    stderr: input.bytes(),
  };
  input.done();
  validateResult(value);
  return value;
}
