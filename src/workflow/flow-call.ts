import type { FlowStrategy } from "./flow-strategies.js";

/** Stub of issue #982: the `call` node's strategy lands in the green commit. */
export const runCall: FlowStrategy = () => {
  throw new Error("not implemented: runCall");
};
