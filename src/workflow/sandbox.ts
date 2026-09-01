import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import type { WorkflowCacheOwnership } from "./cache.js";

export const TOOL_ERROR_PREFIX = "ERROR: ";

export function toolError(message: string): string {
  return `${TOOL_ERROR_PREFIX}${message}`;
}

export interface SandboxFsRoot {
  readonly path: string;
  readonly writable: boolean;
}

export interface SandboxPolicy {
  readonly fsAllow: readonly SandboxFsRoot[];
  readonly egressAllow: readonly string[];
}

const FS_MODES: Readonly<Record<string, boolean>> = { ro: false, rw: true };

/** Operator-controlled capability policy (loaded from disk, never the spec). */
export function loadPolicy(path: string): SandboxPolicy {
  try {
    if (!existsSync(path)) return { fsAllow: [], egressAllow: [] };
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const rawAllow = Array.isArray(data.fs_allow) ? data.fs_allow : [];
    const fsAllow: SandboxFsRoot[] = [];
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

/**
 * Resolve `target` against the filesystem as far as the filesystem knows it:
 * walk up to the NEAREST EXISTING ancestor, resolve that for real, and re-attach
 * the segments that do not exist yet.
 *
 * Resolving only the immediate parent is not enough. Given `link -> outside`,
 * the path `<root>/link/not/created/yet.txt` has no existing target AND no
 * existing parent, so a parent-only rule falls back to the lexical path — which
 * still starts with the root and therefore looks contained, while a create
 * would land outside. Walking to the nearest existing ancestor resolves the
 * link itself and the answer comes out right.
 */
function resolvedAgainstFilesystem(target: string): string {
  const absolute = resolve(target);
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    const real = existsSync(current) ? realpathSync(current) : null;
    if (real !== null) return pending.length === 0 ? real : resolve(real, ...pending);
    const parent = dirname(current);
    // hit the filesystem root without finding anything that exists
    if (parent === current) return absolute;
    pending.unshift(basename(current));
    current = parent;
  }
}

function isWithin(target: string, root: string): boolean {
  // Both sides are resolved so a link that leaves the root is refused, whether
  // the target exists, its parent exists, or neither does.
  const resolvedRoot = resolvedAgainstFilesystem(root);
  const candidate = resolvedAgainstFilesystem(target);
  return (
    candidate === resolvedRoot ||
    candidate.startsWith(resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`)
  );
}

function fsAllowed(rawPath: unknown, roots: readonly string[]): boolean {
  if (typeof rawPath !== "string" || rawPath === "") return false;
  return roots.some((root) => isWithin(rawPath, root));
}

function fsDenial(
  name: string,
  rawPath: unknown,
  workingRoot: string,
  policy: SandboxPolicy,
): string | null {
  const write = name === "write_file";
  const allowedRoots = [workingRoot, ...policy.fsAllow.filter((root) => root.writable || !write).map((root) => root.path)];
  if (fsAllowed(rawPath, allowedRoots)) return null;
  if (write && fsAllowed(rawPath, policy.fsAllow.filter((root) => !root.writable).map((root) => root.path))) {
    return toolError("path is under a read-only workflow root (sandbox denied the write)");
  }
  return toolError("path is outside the workflow working scope (sandbox denied)");
}

function egressAllowed(rawUrl: unknown, policy: SandboxPolicy): boolean {
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
    readonly policy: SandboxPolicy;
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

/** Deny-by-default: what a run gets when no operator policy file is readable. */
export const DENY_ALL_POLICY: SandboxPolicy = Object.freeze({
  fsAllow: Object.freeze([]),
  egressAllow: Object.freeze([]),
});
