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

type Queued = Readonly<{
  order: number;
  runId: string;
  input: AuditInput;
  ownership?: Ownership;
}>;
type AppendOutcome = "saved" | "refused" | "failed";
type DropBucket = Readonly<{ order: number; count: number; ownership?: Ownership }>;

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
  private readonly dropped = new Map<string, DropBucket>();
  private nextOrder = 1;

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
    const order = this.nextOrder;
    this.nextOrder += 1;
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
          Object.freeze({
            order,
            runId,
            input: gap,
            ...(ownership === undefined ? {} : { ownership }),
          }),
        );
        this.kick();
      } else this.markDropped(order, runId, ownership);
      return false;
    }
    if (this.queue.length >= this.capacity) {
      this.markDropped(order, runId, ownership);
      this.warning(`audit queue overflow for run ${runId}`);
      this.kick();
      return false;
    }
    this.queue.push(
      Object.freeze({
        order,
        runId,
        input: sanitized,
        ...(ownership === undefined ? {} : { ownership }),
      }),
    );
    this.kick();
    return true;
  }

  public async flush(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.running !== null || this.queue.length > 0 || this.dropped.size > 0) {
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
    while (!this.closing || this.queue.length > 0 || this.dropped.size > 0) {
      const next = this.queue[0];
      const marker = this.earliestDropped();
      if (marker !== undefined && (next === undefined || marker[1].order < next.order)) {
        if (!(await this.flushDropped(marker[0]))) return;
        continue;
      }
      if (next === undefined) return;
      this.queue.shift();
      const saved = await this.append(next.runId, next.input, next.ownership);
      if (saved === "failed") {
        const gap: AuditInput = Object.freeze({
          event_type: "audit.gap",
          provenance: "dropped",
          payload: Object.freeze({ reason: "sink_failure", dropped_count: 1 }),
        });
        const gapOutcome = await this.append(next.runId, gap, next.ownership);
        if (gapOutcome === "failed") {
          this.stopped = true;
          this.warning(`audit sink failed permanently for run ${next.runId}`);
          return;
        }
      }
    }
  }

  private earliestDropped(): readonly [string, DropBucket] | undefined {
    let earliest: readonly [string, DropBucket] | undefined;
    for (const entry of this.dropped)
      if (earliest === undefined || entry[1].order < earliest[1].order) earliest = entry;
    return earliest;
  }

  private async flushDropped(runId: string): Promise<boolean> {
    const marker = this.dropped.get(runId);
    if (marker === undefined) return true;
    const gap: AuditInput = Object.freeze({
      event_type: "audit.gap",
      provenance: "dropped",
      payload: Object.freeze({ reason: "queue_overflow", dropped_count: marker.count }),
    });
    const outcome = await this.append(runId, gap, marker.ownership);
    if (outcome === "failed") {
      this.stopped = true;
      this.warning(`audit sink failed permanently for run ${runId}`);
      return false;
    }
    this.dropped.delete(runId);
    return true;
  }

  private kick(): void {
    if (
      this.running !== null ||
      this.stopped ||
      (this.queue.length === 0 && this.dropped.size === 0)
    )
      return;
    const task = this.drain();
    this.running = task;
    void task.finally(() => {
      if (this.running === task) this.running = null;
      if ((this.queue.length > 0 || this.dropped.size > 0) && !this.stopped) this.kick();
    });
  }

  private async append(
    runId: string,
    input: AuditInput,
    ownership?: Ownership,
  ): Promise<AppendOutcome> {
    for (let attempt = 0; attempt < this.retries; attempt += 1) {
      try {
        return this.repository.append(runId, input, ownership) === null ? "refused" : "saved";
      } catch (error) {
        if (!this.repository.isBusyError(error) || attempt + 1 >= this.retries) {
          this.warning(
            `audit append failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return "failed";
        }
        await this.sleep(this.retryDelay);
      }
    }
    return "failed";
  }

  private markDropped(order: number, runId: string, ownership?: Ownership): void {
    const prior = this.dropped.get(runId);
    const markerOwnership = prior?.ownership ?? ownership;
    this.dropped.set(
      runId,
      Object.freeze({
        order: Math.min(prior?.order ?? order, order),
        count: (prior?.count ?? 0) + 1,
        ...(markerOwnership === undefined ? {} : { ownership: markerOwnership }),
      }),
    );
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
