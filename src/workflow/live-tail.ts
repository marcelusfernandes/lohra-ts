// Issue #369: red stub. `push`/`snapshot`/`forget`/`isKnown` throw on
// purpose so the `controle-negativo` gate sees a runtime failure in a
// non-test file, not a missing import — `tests/workflow-live-tail.test.ts`
// collects fine and fails on these throws until the real ring buffer
// (bounded by event count AND serialized bytes) lands.
import type { WorkflowLiveEvent } from "./live-events.js";

export const LIVE_TAIL_EVENTS = 256;
export const LIVE_TAIL_BYTES = 64 * 1024;

export interface WorkflowLiveTailSnapshot {
  readonly events: readonly WorkflowLiveEvent[];
  readonly next: number;
  readonly dropped: number;
}

export class WorkflowLiveTail {
  public constructor(private readonly warn: (message: string) => void = () => undefined) {
    this.warn("not implemented: WorkflowLiveTail");
  }

  public isKnown(_runId: string): boolean {
    throw new Error("not implemented: WorkflowLiveTail.isKnown");
  }

  public push(_event: WorkflowLiveEvent): boolean {
    throw new Error("not implemented: WorkflowLiveTail.push");
  }

  public snapshot(_runId: string, _afterIndex = 0): WorkflowLiveTailSnapshot {
    throw new Error("not implemented: WorkflowLiveTail.snapshot");
  }

  public forget(_runId: string): void {
    throw new Error("not implemented: WorkflowLiveTail.forget");
  }
}
