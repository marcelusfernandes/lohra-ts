import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isTaintingTool,
  loadPolicy,
  sandboxDispatch,
  TaintTracker,
  taintWrap,
  type ToolDispatchLike,
} from "../src/workflow/sandbox.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-sandbox-"));
  roots.push(root);
  return root;
}

/** A working root that is ALREADY its own real path, so a test about resolving
 * the TARGET is not accidentally satisfied by the root resolving too (macOS
 * hands out /var/folders/..., a symlink to /private/var/folders/...). */
function realWorkspace(): string {
  return realpathSync(workspace());
}

const base: ToolDispatchLike = (name, args) => `allowed:${name}:${JSON.stringify(args)}`;

describe("loadPolicy", () => {
  it("default-deny when the operator file is absent or malformed", () => {
    const root = workspace();
    expect(loadPolicy(join(root, "missing.json"))).toEqual({ fsAllow: [], egressAllow: [] });
    writeFileSync(join(root, "bad.json"), "{not json");
    expect(loadPolicy(join(root, "bad.json"))).toEqual({ fsAllow: [], egressAllow: [] });
  });

  it("normalizes string roots to rw and object roots with mode, dropping invalid entries", () => {
    const root = workspace();
    writeFileSync(
      join(root, "policy.json"),
      JSON.stringify({
        fs_allow: ["/rw/root", { path: "/ro/root", mode: "ro" }, { path: "/x", mode: "bogus" }, { path: "", mode: "rw" }, 42],
        egress_allow: ["api.test", 7],
      }),
    );
    const policy = loadPolicy(join(root, "policy.json"));
    expect(policy.fsAllow).toEqual([
      { path: "/rw/root", writable: true },
      { path: "/ro/root", writable: false },
    ]);
    expect(policy.egressAllow).toEqual(["api.test"]);
  });
});

describe("sandboxDispatch — fs", () => {
  it("allows reads/writes inside the working root and denies outside with exact text", () => {
    const root = workspace();
    const dispatch = sandboxDispatch(base, { workingRoot: root, policy: loadPolicy(join(root, "missing.json")), tainted: false });
    expect(dispatch("read_file", { path: join(root, "a.txt") })).toContain("allowed");
    expect(dispatch("write_file", { path: join(root, "a.txt") })).toContain("allowed");
    expect(dispatch("read_file", { path: "/etc/passwd" })).toBe(
      "ERROR: path is outside the workflow working scope (sandbox denied)",
    );
    expect(dispatch("write_file", { path: "/tmp/evil.txt" })).toBe(
      "ERROR: path is outside the workflow working scope (sandbox denied)",
    );
  });

  it("honors ro operator roots: read ok, write denied with its own sentence", () => {
    const root = workspace();
    const ro = mkdtempSync(join(tmpdir(), "lohra-ro-"));
    roots.push(ro);
    const policy = { fsAllow: [{ path: ro, writable: false }], egressAllow: [] };
    const dispatch = sandboxDispatch(base, { workingRoot: root, policy, tainted: false });
    expect(dispatch("read_file", { path: join(ro, "f.txt") })).toContain("allowed");
    expect(dispatch("write_file", { path: join(ro, "f.txt") })).toBe(
      "ERROR: path is under a read-only workflow root (sandbox denied the write)",
    );
  });

  it("resolves symlinks via realpath: an escape through a link is refused", () => {
    const root = realWorkspace();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "lohra-outside-")));
    roots.push(outside);
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "s");
    symlinkSync(secret, join(root, "link.txt"));
    const dispatch = sandboxDispatch(base, { workingRoot: root, policy: { fsAllow: [], egressAllow: [] }, tainted: false });
    expect(dispatch("read_file", { path: join(root, "link.txt") })).toBe(
      "ERROR: path is outside the workflow working scope (sandbox denied)",
    );
  });

  it("a working root that is itself a symlink resolves to the real path", () => {
    const root = workspace();
    const real = mkdtempSync(join(tmpdir(), "lohra-real-"));
    roots.push(real);
    try { symlinkSync(real, join(root, "link"), "dir"); } catch { /* concurrent run already linked */ }
    const dispatch = sandboxDispatch(base, { workingRoot: join(root, "link"), policy: { fsAllow: [], egressAllow: [] }, tainted: false });
    expect(dispatch("write_file", { path: join(real, "f.txt") })).toContain("allowed");
  });
});

describe("sandboxDispatch — egress", () => {
  it("web_fetch demands an exact case-insensitive host match", () => {
    const root = workspace();
    const policy = { fsAllow: [], egressAllow: ["Api.Test"] };
    const dispatch = sandboxDispatch(base, { workingRoot: root, policy, tainted: false });
    expect(dispatch("web_fetch", { url: "https://api.test/x" })).toContain("allowed");
    expect(dispatch("web_fetch", { url: "https://API.test/x" })).toContain("allowed");
    expect(dispatch("web_fetch", { url: "https://evil.test/x" })).toBe(
      "ERROR: host is not in the workflow egress allowlist (sandbox denied)",
    );
    expect(dispatch("web_search", { query: "x" })).toContain("allowed");
  });
});

describe("taint", () => {
  it("isTaintingTool covers web_fetch, web_search and mcp_*", () => {
    expect(isTaintingTool("web_fetch")).toBe(true);
    expect(isTaintingTool("web_search")).toBe(true);
    expect(isTaintingTool("mcp_server_tool")).toBe(true);
    expect(isTaintingTool("read_file")).toBe(false);
  });

  it("taintWrap marks the sticky tracker when a tainting tool runs", () => {
    const tracker = new TaintTracker();
    const dispatch = taintWrap(base, tracker);
    expect(tracker.tainted).toBe(false);
    dispatch("web_fetch", { url: "https://api.test" });
    expect(tracker.tainted).toBe(true);
  });

  it("a tainted run gets no fs reads and no web egress, with exact texts", () => {
    const root = workspace();
    const dispatch = sandboxDispatch(base, {
      workingRoot: root,
      policy: { fsAllow: [{ path: root, writable: true }], egressAllow: ["api.test"] },
      tainted: true,
    });
    expect(dispatch("read_file", { path: join(root, "a.txt") })).toBe(
      "ERROR: tainted run: filesystem access is disabled for leaves",
    );
    expect(dispatch("write_file", { path: join(root, "a.txt") })).toBe(
      "ERROR: tainted run: filesystem access is disabled for leaves",
    );
    expect(dispatch("web_fetch", { url: "https://api.test/x" })).toBe(
      "ERROR: tainted run: web egress is disabled for leaves",
    );
    expect(dispatch("web_search", { query: "x" })).toBe(
      "ERROR: tainted run: web egress is disabled for leaves",
    );
  });
});
