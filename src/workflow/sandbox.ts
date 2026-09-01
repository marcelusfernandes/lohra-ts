import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { WorkflowCacheOwnership } from "./cache.js";

export const TOOL_ERROR_PREFIX = "ERROR: ";

export function toolError(message: string): string {
  return `${TOOL_ERROR_PREFIX}${message}`;
}

export interface FsRoot {
  readonly path: string;
  readonly writable: boolean;
}

export interface WorkflowPolicy {
  readonly fsAllow: readonly FsRoot[];
  readonly egressAllow: readonly string[];
}

const FS_MODES: Readonly<Record<string, boolean>> = { ro: false, rw: true };

/** Operator-controlled capability policy (loaded from disk, never the spec). */
export function loadPolicy(path: string): WorkflowPolicy {
  try {
    if (!existsSync(path)) return { fsAllow: [], egressAllow: [] };
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const rawAllow = Array.isArray(data.fs_allow) ? data.fs_allow : [];
    const fsAllow: FsRoot[] = [];
    for (const entry of rawAllow) {
      let raw: unknown;
      let writable = true;
      if (typeof entry === "string") {
        raw = entry;
      } else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        const mode = record.mode ?? "rw";
        raw = record.path;
        if (typeof mode !== "string" || !(mode in FS_MODES)) continue;
        writable = FS_MODES[mode] ?? true;
      } else {
        continue;
      }
      if (typeof raw !== "string" || raw.trim() === "") continue;
      fsAllow.push({ path: resolve(raw.replace(/^~(?=$|\/)/, homedir())), writable });
    }
    const rawEgress = Array.isArray(data.egress_allow) ? data.egress_allow : [];
    const egressAllow = rawEgress.filter((host): host is string => typeof host === "string");
    return { fsAllow, egressAllow };
  } catch {
    return { fsAllow: [], egressAllow: [] };
  }
}

export type ToolDispatchLike = (name: string, args: Readonly<Record<string, unknown>>) => string;

const FS_TOOLS: ReadonlySet<string> = new Set(["read_file", "write_file"]);
const EGRESS_TOOLS: ReadonlySet<string> = new Set(["web_fetch", "web_search"]);

function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isWithin(target: string, root: string): boolean {
  // Both sides are resolved so a symlink escape is refused. A target that
  // EXISTS must resolve inside; only a NOT-YET-EXISTING target (a create) is
  // judged by its real parent directory.
  const resolvedRoot = realPathOf(root);
  const inside = (candidate: string): boolean =>
    candidate === resolvedRoot ||
    candidate.startsWith(resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`);
  const resolvedTarget = realPathOf(target);
  if (resolvedTarget !== target) return inside(resolvedTarget);
  return inside(realPathOf(resolve(target, "..")));
}

function fsAllowed(rawPath: unknown, roots: readonly string[]): boolean {
  if (typeof rawPath !== "string" || rawPath === "") return false;
  return roots.some((root) => isWithin(rawPath, root));
}

function fsDenial(
  name: string,
  rawPath: unknown,
  workingRoot: string,
  policy: WorkflowPolicy,
): string | null {
  const write = name === "write_file";
  const allowedRoots = [workingRoot, ...policy.fsAllow.filter((root) => root.writable || !write).map((root) => root.path)];
  if (fsAllowed(rawPath, allowedRoots)) return null;
  if (write && fsAllowed(rawPath, policy.fsAllow.filter((root) => !root.writable).map((root) => root.path))) {
    return toolError("path is under a read-only workflow root (sandbox denied the write)");
  }
  return toolError("path is outside the workflow working scope (sandbox denied)");
}

function egressAllowed(rawUrl: unknown, policy: WorkflowPolicy): boolean {
  if (typeof rawUrl !== "string") return false;
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return policy.egressAllow.some((allowed) => allowed.toLowerCase() === host);
}

/**
 * Wrap a leaf dispatch with the fs/egress allowlists + taint gate. The policy
 * lives in operator config, NEVER in the workflow spec — an injected spec
 * cannot widen its own capability. Containment resolves real paths, so a
 * symlink escape is refused.
 */
export function sandboxDispatch(
  base: ToolDispatchLike,
  options: {
    readonly workingRoot: string;
    readonly policy: WorkflowPolicy;
    readonly tainted: boolean;
  },
): ToolDispatchLike {
  const { workingRoot, policy, tainted } = options;
  return (name, args) => {
    if (FS_TOOLS.has(name)) {
      if (tainted) return toolError("tainted run: filesystem access is disabled for leaves");
      const denial = fsDenial(name, args.path, workingRoot, policy);
      if (denial !== null) return denial;
    }
    if (EGRESS_TOOLS.has(name)) {
      if (tainted) return toolError("tainted run: web egress is disabled for leaves");
      if (name === "web_fetch" && !egressAllowed(args.url, policy)) {
        return toolError("host is not in the workflow egress allowlist (sandbox denied)");
      }
    }
    return base(name, args);
  };
}

/** Tools that bring external/untrusted content into the conversation (§8.2). */
export function isTaintingTool(name: string): boolean {
  return name === "web_fetch" || name === "web_search" || name.startsWith("mcp_");
}

export class TaintTracker {
  private taintedState = false;

  public get tainted(): boolean {
    return this.taintedState;
  }

  public mark(): void {
    this.taintedState = true;
  }
}

export function taintWrap(base: ToolDispatchLike, tracker: TaintTracker): ToolDispatchLike {
  return (name, args) => {
    if (isTaintingTool(name)) tracker.mark();
    return base(name, args);
  };
}

export function ownershipOf(fence: number, holder: string, now: number): WorkflowCacheOwnership {
  return { fence, holder, now };
}

