import { deepCopyReadonly } from "./types.js";

export interface FsRoot {
  readonly path: string;
  readonly writable: boolean;
}

export interface WorkflowPolicy {
  readonly fsAllow: readonly FsRoot[];
  readonly egressAllow: readonly string[];
}

function normalizePolicy(value: unknown): WorkflowPolicy {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const fsAllow: FsRoot[] = [];
  if (Array.isArray(record.fs_allow)) {
    for (const item of record.fs_allow) {
      if (typeof item === "string" && item !== "") {
        fsAllow.push({ path: item, writable: true });
      } else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const root = item as Record<string, unknown>;
        if (
          typeof root.path === "string" &&
          root.path !== "" &&
          (root.mode === undefined || root.mode === "ro" || root.mode === "rw")
        ) {
          fsAllow.push({ path: root.path, writable: root.mode !== "ro" });
        }
      }
    }
  }
  const egressAllow = Array.isArray(record.egress_allow)
    ? record.egress_allow.filter((item): item is string => typeof item === "string")
    : [];
  return deepCopyReadonly({ fsAllow, egressAllow });
}

export function normalizeWorkflowPolicy(raw: unknown): WorkflowPolicy {
  return normalizePolicy(raw);
}

export function parseWorkflowPolicy(text: string): WorkflowPolicy {
  try {
    return normalizePolicy(JSON.parse(text) as unknown);
  } catch {
    return normalizePolicy({});
  }
}
