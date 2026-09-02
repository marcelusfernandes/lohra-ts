import { createHash } from "node:crypto";

import { combineUsage, usage } from "../pricing/usage.js";
import type { Usage } from "../pricing/types.js";

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(canonical).join(", ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}: ${canonical(item)}`);
    return `{${pairs.join(", ")}}`;
  }
  return JSON.stringify(`<${typeof value}>`);
}

export function contentHash(...parts: readonly unknown[]): string {
  return createHash("sha256").update(canonical(parts), "utf8").digest("hex");
}

export interface CacheLookup {
  readonly hit: boolean;
  readonly output: unknown;
  readonly cost: Usage | null;
}

export interface WorkflowCacheOwnership {
  readonly fence: number;
  readonly holder: string;
  readonly now: number;
}

export interface WorkflowCache {
  get(runId: string, hash: string): CacheLookup;
  put(
    runId: string,
    hash: string,
    nodeId: string,
    output: unknown,
    cost: Usage | null,
    ownership?: WorkflowCacheOwnership,
  ): boolean;
  totalCost(runId: string): Readonly<{ inputTokens: number; outputTokens: number }>;
  totalSplit(runId: string): Usage;
}

interface Cell {
  readonly output: unknown;
  readonly nodeId: string;
  readonly cost: Usage;
}

export class MemoryWorkflowCache implements WorkflowCache {
  private readonly cells = new Map<string, Cell>();
  private readonly refuseWrite: ((runId: string, hash: string) => boolean) | undefined;

  constructor(options: { readonly refuseWrite?: (runId: string, hash: string) => boolean } = {}) {
    this.refuseWrite = options.refuseWrite;
  }

  private key(runId: string, hash: string): string {
    return `${runId}\0${hash}`;
  }

  get(runId: string, hash: string): CacheLookup {
    const cell = this.cells.get(this.key(runId, hash));
    return cell === undefined
      ? Object.freeze({ hit: false, output: null, cost: null })
      : Object.freeze({
          hit: true,
          output: structuredClone(cell.output),
          cost: structuredClone(cell.cost),
        });
  }

  put(runId: string, hash: string, nodeId: string, output: unknown, cost: Usage | null): boolean {
    if (this.refuseWrite?.(runId, hash) === true) return false;
    this.cells.set(
      this.key(runId, hash),
      Object.freeze({ output: structuredClone(output), nodeId, cost: cost ?? usage() }),
    );
    return true;
  }

  totalCost(runId: string): Readonly<{ inputTokens: number; outputTokens: number }> {
    const split = this.totalSplit(runId);
    return Object.freeze({ inputTokens: split.inputTokens, outputTokens: split.outputTokens });
  }

  totalSplit(runId: string): Usage {
    let total: Usage | null = null;
    for (const [key, cell] of this.cells) {
      if (key.startsWith(`${runId}\0`)) total = combineUsage(total, cell.cost);
    }
    return total ?? usage();
  }
}
