import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";
import { writeFileTool } from "../src/tools/filesystem.js";
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
        fs_allow: [
          "/rw/root",
          { path: "/ro/root", mode: "ro" },
          { path: "/x", mode: "bogus" },
          { path: "", mode: "rw" },
          42,
        ],
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
    const dispatch = sandboxDispatch(base, {
      workingRoot: root,
      policy: loadPolicy(join(root, "missing.json")),
      tainted: false,
    });
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
    const dispatch = sandboxDispatch(base, {
      workingRoot: root,
      policy: { fsAllow: [], egressAllow: [] },
      tainted: false,
    });
    expect(dispatch("read_file", { path: join(root, "link.txt") })).toBe(
      "ERROR: path is outside the workflow working scope (sandbox denied)",
    );
  });

  it("a link escapes even when neither the target NOR its parent exists yet", () => {
    // The create case the parent-only rule missed: `<root>/link/a/b/c.txt` has
    // no existing target and no existing parent, so resolving only the parent
    // fell back to the lexical path — which still starts with the root.
    const root = realWorkspace();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "lohra-outside-")));
    symlinkSync(outside, join(root, "link"), "dir");
    const dispatch = sandboxDispatch(base, {
      workingRoot: root,
      policy: { fsAllow: [], egressAllow: [] },
      tainted: false,
    });
    const denial = "ERROR: path is outside the workflow working scope (sandbox denied)";
    // target exists
    writeFileSync(join(outside, "there.txt"), "x");
    expect(dispatch("write_file", { path: join(root, "link", "there.txt") })).toBe(denial);
    // target missing, parent (the link) exists
    expect(dispatch("write_file", { path: join(root, "link", "new.txt") })).toBe(denial);
    // NEITHER the target nor any of its parents below the link exist
    expect(dispatch("write_file", { path: join(root, "link", "a", "b", "c.txt") })).toBe(denial);
    expect(dispatch("read_file", { path: join(root, "link", "a", "b", "c.txt") })).toBe(denial);
    // and a deep path that never leaves the root is still allowed to be created
    expect(dispatch("write_file", { path: join(root, "a", "b", "c.txt") })).toContain("allowed");
  });

  it("a working root that is itself a symlink resolves to the real path", () => {
    const root = workspace();
    const real = mkdtempSync(join(tmpdir(), "lohra-real-"));
    roots.push(real);
    try {
      symlinkSync(real, join(root, "link"), "dir");
    } catch {
      /* concurrent run already linked */
    }
    const dispatch = sandboxDispatch(base, {
      workingRoot: join(root, "link"),
      policy: { fsAllow: [], egressAllow: [] },
      tainted: false,
    });
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

// Issue #248: branches of one run share ONE working root, fenced per
// acquisition (`src/workflow/service.ts`), not per branch. Two leaves that
// write the SAME file race at the filesystem, not inside the sandbox — this
// pins the observed behavior (last writer wins, silently) as the contract,
// not a bug to fix here (Fora de escopo: `write_file(mode="append")`).
describe("sandboxDispatch — fan-out over a shared working root (#248)", () => {
  it("two branches writing the SAME file: both succeed, last writer wins, silently", () => {
    const root = workspace();
    const fsBase: ToolDispatchLike = (_name, args) => writeFileTool(args);
    const dispatch = sandboxDispatch(fsBase, {
      workingRoot: root,
      policy: { fsAllow: [{ path: root, writable: true }], egressAllow: [] },
      tainted: false,
    });
    const shared = join(root, "shared.txt");

    const resultA = dispatch("write_file", { path: shared, content: "from-branch-a" });
    const resultB = dispatch("write_file", { path: shared, content: "from-branch-b" });

    expect(resultA).not.toContain("ERROR");
    expect(resultB).not.toContain("ERROR");
    expect(readFileSync(shared, "utf8")).toBe("from-branch-b");
  });

  it("two branches writing DIFFERENT files under the same root: both survive intact", () => {
    const root = workspace();
    const fsBase: ToolDispatchLike = (_name, args) => writeFileTool(args);
    const dispatch = sandboxDispatch(fsBase, {
      workingRoot: root,
      policy: { fsAllow: [{ path: root, writable: true }], egressAllow: [] },
      tainted: false,
    });
    const fileA = join(root, "branch-a.txt");
    const fileB = join(root, "branch-b.txt");

    const resultA = dispatch("write_file", { path: fileA, content: "a" });
    const resultB = dispatch("write_file", { path: fileB, content: "b" });

    expect(resultA).not.toContain("ERROR");
    expect(resultB).not.toContain("ERROR");
    expect(readFileSync(fileA, "utf8")).toBe("a");
    expect(readFileSync(fileB, "utf8")).toBe("b");
  });
});

describe("run_workflow tool description — fan-out doctrine (#248)", () => {
  it("names the shared-filesystem doctrine: one file per leaf, aggregate downstream", () => {
    const runWorkflow = BUILTIN_DEFINITIONS.find(
      (definition) => definition.function.name === "run_workflow",
    );
    expect(runWorkflow).toBeDefined();
    const description = runWorkflow?.function.description ?? "";
    expect(description).toContain("Branches in the same run share ONE working filesystem root");
    expect(description).toContain("one file per leaf");
  });
});
