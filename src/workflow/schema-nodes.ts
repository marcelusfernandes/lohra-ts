import { Node, SpecIssue } from "./types.js";

export type NodeValidator = (node: Node, issues: SpecIssue[]) => void;

export function validateGate(node: Node, issues: SpecIssue[]): void {
  void node;
  void issues;
  throw new Error("not implemented: validateGate");
}

export const NODE_VALIDATORS: ReadonlyMap<string, NodeValidator> = new Map();
