import type { FlowStrategy } from "./flow-strategies.js";
import type { Node } from "./types.js";

export const runSwitch: FlowStrategy = () => {
  throw new Error("not implemented: runSwitch");
};

export function switchTakesNoLeaf(_node: Node, _output: unknown): boolean {
  throw new Error("not implemented: switchTakesNoLeaf");
}
