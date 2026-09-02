export type NodeProgressState = "pending" | "running" | "complete" | "null";

export interface NodeProgress {
  readonly id: string;
  readonly state: NodeProgressState;
  readonly items?: Readonly<{ done: number; total: number }>;
}
export interface ProgressSnapshot {
  readonly total: number;
  readonly done: number;
  readonly running: number;
  readonly pending: number;
  readonly nodes: readonly NodeProgress[];
}

export class ProgressTracker {
  private order: string[] = [];
  private readonly states = new Map<string, NodeProgressState>();
  private readonly items = new Map<string, { done: number; total: number }>();

  reset(ids: readonly string[]): void {
    this.order = [...ids];
    this.states.clear();
    this.items.clear();
    for (const id of ids) this.states.set(id, "pending");
  }

  markRunning(id: string): void {
    this.states.set(id, "running");
  }

  settle(id: string, output: unknown): void {
    this.states.set(id, output === null ? "null" : "complete");
  }

  noteItems(id: string, done: number, total: number): void {
    const previous = this.items.get(id);
    if (previous !== undefined && done < previous.done) return;
    this.items.set(id, { done: Math.max(0, done), total: Math.max(0, total) });
  }

  snapshot(): ProgressSnapshot {
    const nodes = this.order.map((id) => {
      const item = this.items.get(id);
      return Object.freeze({
        id,
        state: this.states.get(id) ?? "pending",
        ...(item === undefined ? {} : { items: Object.freeze({ ...item }) }),
      });
    });
    return Object.freeze({
      total: nodes.length,
      done: nodes.filter((node) => node.state === "complete" || node.state === "null").length,
      running: nodes.filter((node) => node.state === "running").length,
      pending: nodes.filter((node) => node.state === "pending").length,
      nodes: Object.freeze(nodes),
    });
  }
}
