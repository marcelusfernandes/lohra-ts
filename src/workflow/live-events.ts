export type WorkflowLiveKind = "plan" | "node" | "items" | "fault" | "done";

export type WorkflowLiveEvent = Readonly<{
  readonly kind: WorkflowLiveKind;
  readonly run_id: string;
  readonly node_id?: string;
  readonly name?: string;
  readonly state?: string;
  readonly done?: number;
  readonly total?: number;
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly nodes?: readonly string[];
  readonly fault?: string;
}>;

export class WorkflowLiveEvents {
  private readonly lastItems = new Map<string, number>();

  public constructor(
    private readonly observer?: (event: WorkflowLiveEvent) => void,
    private readonly now: () => number = () => Date.now() / 1_000,
    private readonly warning: (message: string) => void = () => undefined,
  ) {}

  public emit(event: WorkflowLiveEvent): boolean {
    const snapshot = Object.freeze({
      ...event,
      ...(event.nodes === undefined ? {} : { nodes: Object.freeze([...event.nodes]) }),
      ...(event.budget === undefined ? {} : { budget: Object.freeze({ ...event.budget }) }),
    });
    if (snapshot.kind === "items") {
      const key = `${snapshot.run_id}\u0000${snapshot.node_id ?? ""}`;
      const first = (snapshot.done ?? 0) <= 0;
      const last = snapshot.total !== undefined && (snapshot.done ?? 0) >= snapshot.total;
      const current = this.now();
      const prior = this.lastItems.get(key);
      if (!first && !last && prior !== undefined && current - prior < 1) return false;
      this.lastItems.set(key, current);
    }
    if (snapshot.kind === "done") {
      const prefix = `${snapshot.run_id}\u0000`;
      for (const key of this.lastItems.keys())
        if (key.startsWith(prefix)) this.lastItems.delete(key);
    }
    try {
      this.observer?.(snapshot);
    } catch (error) {
      this.warning(
        `workflow: live observer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  }

  public trackedNodes(): number {
    return this.lastItems.size;
  }
}
