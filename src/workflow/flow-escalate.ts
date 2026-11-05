import type { FlowDeps } from "./flow-strategies.js";
import type { Node } from "./types.js";

/** Stub: the real strategy lands with the green commit. */
export function runEscalate(
  _deps: FlowDeps,
  _node: Node,
  _context: Readonly<Record<string, unknown>>,
): unknown {
  throw new Error("not implemented: runEscalate");
}

/** Stub: the real check lands with the green commit. */
export function escalateDidNotFire(_node: Node, _output: unknown): boolean {
  throw new Error("not implemented: escalateDidNotFire");
}
