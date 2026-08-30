import { findRefs, isValidRef } from "./refs.js";
import type { WorkflowSpec } from "./types.js";

export function refRoots(value: unknown): ReadonlySet<string> {
  const roots = new Set<string>();
  for (const reference of findRefs(value)) {
    if (!isValidRef(reference)) continue;
    const root = reference.split(".", 1)[0];
    if (root !== undefined && root !== "") roots.add(root);
  }
  return roots;
}

export function dependencies(
  node: WorkflowSpec["nodes"][number],
  nodeIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const deps = new Set<string>();
  const explicit = node.fields.depends_on;
  if (Array.isArray(explicit)) {
    for (const dependency of explicit) {
      if (typeof dependency === "string" && nodeIds.has(dependency)) deps.add(dependency);
    }
  }
  for (const root of refRoots(node.fields)) {
    if (nodeIds.has(root)) deps.add(root);
  }
  return deps;
}

export function topologicalOrder(spec: WorkflowSpec): WorkflowSpec["nodes"] {
  const ids = new Set(spec.nodes.map((node) => node.id));
  const pending = new Map(spec.nodes.map((node) => [node.id, new Set(dependencies(node, ids))]));
  const order: WorkflowSpec["nodes"][number][] = [];
  while (pending.size > 0) {
    const next = spec.nodes.find(
      (node) => pending.has(node.id) && (pending.get(node.id)?.size ?? 0) === 0,
    );
    if (next === undefined) throw new Error("workflow dependency graph contains a cycle");
    order.push(next);
    pending.delete(next.id);
    for (const deps of pending.values()) deps.delete(next.id);
  }
  return Object.freeze(order);
}
