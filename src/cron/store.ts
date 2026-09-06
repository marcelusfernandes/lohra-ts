import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  JsonFloat,
  jsonFloat,
  parseJsonPreservingNumbers,
  stringifyJsonPreservingNumbers,
} from "../serialization/json-numbers.js";
import { CronStoreError, CronValidationError } from "./errors.js";
import { validateJob } from "./validate.js";

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly type: string;
  readonly value: unknown;
  readonly enabled: boolean;
  readonly created_at: number;
  readonly last_run_at: number | null;
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 20;

type PathKind = "absent" | "file" | "directory" | "unreadable";

function pathKind(path: string): PathKind {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return "absent";
  }
  if (stats.isDirectory()) return "directory";
  if (!stats.isFile()) return "unreadable";
  try {
    accessSync(path, constants.R_OK);
  } catch {
    return "unreadable";
  }
  return "file";
}

// docs/adr/0003-native-wire-format.md item 4: a `once` job's value can be
// NaN/Infinity by design — a ghost job (Emenda E3/R5) that is well-formed
// but semantically unreachable (schedule.ts's isPermanentlyUnreachable) —
// and this store must keep round-tripping it without ever writing the bare
// `NaN`/`Infinity` token, which is not valid JSON. `NON_FINITE_KEY` is a
// small, self-describing, standards-conformant JSON object used only for
// this wire slot; `stringifyJsonPreservingNumbers` never sees a non-finite
// number and therefore never throws while (re)writing a pre-existing ghost.
const NON_FINITE_KEY = "__lohra_cron_non_finite__";
type NonFiniteToken = "NaN" | "Infinity" | "-Infinity";

function nonFiniteToken(value: number): NonFiniteToken {
  if (Number.isNaN(value)) return "NaN";
  return value > 0 ? "Infinity" : "-Infinity";
}

function tokenToNumber(token: NonFiniteToken): number {
  if (token === "NaN") return Number.NaN;
  return token === "Infinity" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

function encodeNonFinite(value: number): { readonly [NON_FINITE_KEY]: NonFiniteToken } {
  return { [NON_FINITE_KEY]: nonFiniteToken(value) };
}

function decodeNonFinite(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const token = (value as Record<string, unknown>)[NON_FINITE_KEY];
  return token === "NaN" || token === "Infinity" || token === "-Infinity"
    ? tokenToNumber(token)
    : null;
}

function unwrapNumber(value: unknown): unknown {
  if (value instanceof JsonFloat) return value.value;
  const decoded = decodeNonFinite(value);
  return decoded === null ? value : decoded;
}

function isNumeric(value: unknown): boolean {
  return typeof value === "number" || value instanceof JsonFloat;
}

/**
 * The Emenda E2/E3 boundary: fail-closed applies to structure, never to semantics. A job entry
 * with every required field of the right kind is well-formed even when a field's VALUE is
 * unreachable (NaN) — that is `nan_literal`'s whole point (decision 4/assertion 26). A missing
 * key, wrong type, or non-object entry is what actually makes a store unusable.
 */
function isWellFormedJobEntry(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return false;
  if (typeof record.name !== "string") return false;
  if (typeof record.prompt !== "string") return false;
  if (typeof record.type !== "string") return false;
  if (!("value" in record)) return false;
  if (typeof record.enabled !== "boolean") return false;
  if (!isNumeric(record.created_at)) return false;
  if (record.last_run_at !== null && !isNumeric(record.last_run_at)) return false;
  return true;
}

function normalizeJob(record: Record<string, unknown>): CronJob {
  return {
    id: record.id as string,
    name: record.name as string,
    prompt: record.prompt as string,
    type: record.type as string,
    value: unwrapNumber(record.value),
    enabled: record.enabled as boolean,
    created_at: unwrapNumber(record.created_at) as number,
    last_run_at: record.last_run_at === null ? null : (unwrapNumber(record.last_run_at) as number),
  };
}

/**
 * Reads `path` and returns the job list. `absent` (nothing at the path — a fresh profile before
 * its first `add`) is the legitimate empty case, matching the oracle (Emenda E2): returns `[]`,
 * never throws. Anything else that is not a well-formed, usable jobs file — including a job
 * entry that is not itself well-formed — throws `CronStoreError` (the ADR's fail-closed
 * boundary, collapsing the oracle's silent/crash/ghost 3-way split into one stable failure).
 */
export function readJobs(path: string): CronJob[] {
  const kind = pathKind(path);
  if (kind === "absent") return [];
  if (kind === "directory") throw new CronStoreError(path, "path is a directory, not a file");
  if (kind === "unreadable") throw new CronStoreError(path, "path is not readable");

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CronStoreError(path, "read failed");
  }

  let parsed: unknown;
  try {
    parsed = parseJsonPreservingNumbers(raw);
  } catch {
    throw new CronStoreError(path, "content is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CronStoreError(path, "root is not an object");
  }
  const jobsField = (parsed as Record<string, unknown>).jobs;
  if (!Array.isArray(jobsField)) {
    throw new CronStoreError(path, "'jobs' field is not a list");
  }

  const jobs: CronJob[] = [];
  for (const entry of jobsField) {
    if (!isWellFormedJobEntry(entry)) {
      throw new CronStoreError(path, "a job entry is malformed");
    }
    jobs.push(normalizeJob(entry));
  }
  return jobs;
}

function wrapValueForWrite(value: unknown, type: string): unknown {
  if (type === "interval") return value;
  if (type === "once" && typeof value === "number") {
    return Number.isFinite(value) ? jsonFloat(value) : encodeNonFinite(value);
  }
  return value;
}

function serializeJobs(jobs: readonly CronJob[]): string {
  const wire = jobs.map((job) => ({
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    type: job.type,
    value: wrapValueForWrite(job.value, job.type),
    enabled: job.enabled,
    created_at: jsonFloat(job.created_at),
    last_run_at: job.last_run_at === null ? null : jsonFloat(job.last_run_at),
  }));
  return stringifyJsonPreservingNumbers({ jobs: wire }, 2);
}

/** Atomic write: unique temp file per call (never a fixed name, per the ADR), rename over target. */
function writeJobsAtomic(path: string, jobs: readonly CronJob[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.jobs-${randomUUID()}.json.tmp`);
  writeFileSync(tmp, serializeJobs(jobs), "utf8");
  renameSync(tmp, path);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Exclusive, cross-process coordination per store path (the ADR's requirement beyond the
 * oracle's in-process-only `threading.RLock` — decision 5, `[processo-ts]` evidence, never
 * claimed as oracle parity). `mkdir` is atomic on POSIX; a concurrent holder sees `EEXIST` and
 * retries until the lock frees or the timeout elapses.
 */
function withStoreLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        throw new Error(`cron store lock timed out waiting for ${lockPath}`, { cause: error });
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lockPath);
  }
}

export class CronStore {
  private readonly path: string;

  public constructor(home: string) {
    this.path = join(home, "cron", "jobs.json");
  }

  public list(): CronJob[] {
    return withStoreLock(this.path, () => readJobs(this.path));
  }

  public get(jobId: string): CronJob | null {
    return this.list().find((job) => job.id === jobId) ?? null;
  }

  public add(input: {
    readonly name: string;
    readonly prompt: string;
    readonly type: string;
    readonly value: unknown;
  }): CronJob {
    validateJob(input.name, input.prompt, input.type, input.value);
    return withStoreLock(this.path, () => {
      const jobs = readJobs(this.path);
      const job: CronJob = {
        id: randomUUID().replace(/-/gu, ""),
        name: input.name,
        prompt: input.prompt,
        type: input.type,
        value: input.value,
        enabled: true,
        created_at: Date.now() / 1000,
        last_run_at: null,
      };
      writeJobsAtomic(this.path, [...jobs, job]);
      return job;
    });
  }

  public remove(jobId: string): boolean {
    return withStoreLock(this.path, () => {
      const jobs = readJobs(this.path);
      const remaining = jobs.filter((job) => job.id !== jobId);
      if (remaining.length === jobs.length) return false;
      writeJobsAtomic(this.path, remaining);
      return true;
    });
  }

  public setEnabled(jobId: string, enabled: boolean): boolean {
    return this.mutate(jobId, (job) => ({ ...job, enabled }));
  }

  public markRun(jobId: string, when: number): boolean {
    return this.mutate(jobId, (job) => ({ ...job, last_run_at: when }));
  }

  private mutate(jobId: string, change: (job: CronJob) => CronJob): boolean {
    return withStoreLock(this.path, () => {
      const jobs = readJobs(this.path);
      const index = jobs.findIndex((job) => job.id === jobId);
      if (index < 0) return false;
      const out = jobs.slice();
      out[index] = change(jobs[index] as CronJob);
      writeJobsAtomic(this.path, out);
      return true;
    });
  }
}

export { CronStoreError, CronValidationError };
