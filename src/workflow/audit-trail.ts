import type { Ownership } from "../state/workflow-repository.js";
import type { AuditRepository } from "../state/audit-repository.js";
import { AUDIT_QUEUE_CAPACITY, safeAuditMetadata, type AuditInput } from "./audit-model.js";

export interface AuditTrailOptions {
  readonly capacity?: number;
  readonly retryLimit?: number;
  readonly retryDelayMs?: number;
  readonly warning?: (message: string) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

type Queued = Readonly<{ runId: string; input: AuditInput; ownership?: Ownership }>;

export class AuditTrail {
  private readonly queue: Queued[] = [];
  private readonly capacity: number;
  private readonly retries: number;
  private readonly retryDelay: number;
  private readonly warning: (message: string) => void;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private running: Promise<void> | null = null;
  private closing = false;
  private stopped = false;
  private dropped = 0;

  public constructor(
    private readonly repository: AuditRepository,
    options: AuditTrailOptions = {},
  ) {
    this.capacity = Math.max(1, Math.trunc(options.capacity ?? AUDIT_QUEUE_CAPACITY));
    this.retries = Math.max(1, Math.trunc(options.retryLimit ?? 3));
    this.retryDelay = Math.max(0, Math.trunc(options.retryDelayMs ?? 5));
    this.warning = options.warning ?? (() => undefined);
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  public record(runId: string, input: AuditInput, ownership?: Ownership): boolean {
    if (this.closing || this.stopped) {
      this.warning(`audit unavailable for run ${runId}: writer is closed`);
      return false;
    }
    let sanitized: AuditInput;
    try {
      sanitized = Object.freeze({
        event_type: input.event_type,
        ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
        ...(input.segment_id === undefined ? {} : { segment_id: input.segment_id }),
        ...(input.node_id === undefined ? {} : { node_id: input.node_id }),
        ...(input.sub_id === undefined ? {} : { sub_id: input.sub_id }),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        ...(input.created_at === undefined ? {} : { created_at: input.created_at }),
        payload: safeAuditMetadata(input.payload ?? {}),
      });
    } catch (error) {
      this.warning(
        `audit sanitizer failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      const gap: AuditInput = Object.freeze({
        event_type: "audit.gap",
        provenance: "dropped",
        payload: Object.freeze({ reason: "corrupt_payload", dropped_count: 1 }),
      });
      if (this.queue.length < this.capacity) {
        this.queue.push(
          Object.freeze({ runId, input: gap, ...(ownership === undefined ? {} : { ownership }) }),
        );
        this.kick();
      } else this.dropped += 1;
      return false;
    }
    if (this.queue.length >= this.capacity) {
      this.dropped += 1;
      this.warning(`audit queue overflow for run ${runId}`);
      return false;
    }
    this.queue.push(
      Object.freeze({ runId, input: sanitized, ...(ownership === undefined ? {} : { ownership }) }),
    );
    this.kick();
    return true;
  }

  public async flush(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.running !== null || this.queue.length > 0) {
      this.kick();
      const pending = this.running;
      if (pending === null) break;
      if (!(await this.withTimeout(pending, Math.max(0, deadline - Date.now())))) return false;
    }
    return !this.stopped;
  }

  public async shutdown(timeoutMs = 5_000): Promise<boolean> {
    this.closing = true;
    const ok = await this.flush(timeoutMs);
    this.stopped = true;
    if (!ok) this.warning("audit shutdown timed out with a failed writer");
    return ok;
  }

  private async drain(): Promise<void> {
    while (!this.closing || this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) return;
      if (this.dropped > 0) {
        const count = this.dropped;
        const gap: AuditInput = Object.freeze({
          event_type: "audit.gap",
          provenance: "audit",
          payload: Object.freeze({ reason: "queue_overflow", dropped_count: count }),
        });
        if (await this.append(next.runId, gap, next.ownership)) this.dropped = 0;
      }
      const saved = await this.append(next.runId, next.input, next.ownership);
      if (!saved) {
        this.dropped += 1;
        const gap: AuditInput = Object.freeze({
          event_type: "audit.gap",
          provenance: "audit",
          payload: Object.freeze({ reason: "sink_failure", dropped_count: 1 }),
        });
        if (await this.append(next.runId, gap, next.ownership)) this.dropped -= 1;
        else {
          this.stopped = true;
          this.warning(`audit sink failed permanently for run ${next.runId}`);
          return;
        }
      }
    }
  }

  private kick(): void {
    if (this.running !== null || this.stopped || this.queue.length === 0) return;
    const task = this.drain();
    this.running = task;
    void task.finally(() => {
      if (this.running === task) this.running = null;
      if (this.queue.length > 0 && !this.stopped) this.kick();
    });
  }

  private async append(runId: string, input: AuditInput, ownership?: Ownership): Promise<boolean> {
    for (let attempt = 0; attempt < this.retries; attempt += 1) {
      try {
        return this.repository.append(runId, input, ownership) !== null;
      } catch (error) {
        if (!this.repository.isBusyError(error) || attempt + 1 >= this.retries) {
          this.warning(
            `audit append failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
        await this.sleep(this.retryDelay);
      }
    }
    return false;
  }

  private async withTimeout(pending: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timeout = setTimeout(
        () => {
          resolve(false);
        },
        Math.max(0, timeoutMs),
      );
    });
    const settled = pending.then(
      () => true,
      () => false,
    );
    const result = await Promise.race([settled, expired]);
    if (timeout !== undefined) clearTimeout(timeout);
    return result && !this.stopped;
  }
}
