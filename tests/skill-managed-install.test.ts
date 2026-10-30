import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  manageSkillInstallation,
  ManagedInstallError,
  type ManagedInstallOperations,
} from "../src/skills/managed-install.js";
import { readExportable } from "../src/skills/export.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "lohra-managed-test-")));
  roots.push(root);
  const skills = join(root, "skills");
  const kit = join(skills, "use-lohra-ts");
  const file = join(kit, "SKILL.md");
  const marker = join(kit, ".lohra-managed.json");
  return {
    root,
    skills,
    kit,
    file,
    marker,
    run: (action: "add" | "remove", operations: Partial<ManagedInstallOperations> = {}) =>
      manageSkillInstallation({ action, skillsDirectory: skills }, operations),
  };
}
function caught(run: () => unknown): ManagedInstallError {
  try {
    run();
  } catch (error) {
    if (error instanceof ManagedInstallError) return error;
    throw error;
  }
  throw new Error("expected explicit installation failure");
}

describe("managed skill installation", () => {
  it("installs the real TS asset, updates intact ownership and performs idempotent add/remove", () => {
    const f = fixture();
    expect(f.run("remove").status).toBe("noop");
    expect(fs.existsSync(f.skills)).toBe(false);
    expect(f.run("add").status).toBe("installed");
    expect(fs.readFileSync(f.file, "utf8")).toBe(readExportable("use-lohra-ts"));
    const marker = fs.readFileSync(f.marker, "utf8");
    expect(marker).toContain('"owner":"lohra-ts"');
    expect(f.run("add").status).toBe("noop");
    expect(fs.readFileSync(f.marker, "utf8")).toBe(marker);
    expect(f.run("add", { readKit: () => "fixture next kit\n" }).status).toBe("updated");
    expect(fs.readFileSync(f.file, "utf8")).toBe("fixture next kit\n");
    expect(f.run("remove").status).toBe("removed");
    expect(f.run("remove").status).toBe("noop");
  });
  it("preserves edited and unowned content, including an identical unmanaged copy", () => {
    const f = fixture();
    f.run("add");
    fs.writeFileSync(f.file, "local edit");
    for (const action of ["add", "remove"] as const)
      expect(caught(() => f.run(action)).code).toBe("conflict");
    expect(fs.readFileSync(f.file, "utf8")).toBe("local edit");
    fs.unlinkSync(f.marker);
    fs.writeFileSync(f.file, readExportable("use-lohra-ts"));
    expect(caught(() => f.run("add")).code).toBe("conflict");
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(caught(() => f.run("remove")).code).toBe("conflict");
  });
  it("preserves extras and neighboring skills during update and scoped removal", () => {
    const f = fixture();
    f.run("add");
    const neighbor = join(f.skills, "third-party");
    fs.mkdirSync(neighbor);
    fs.writeFileSync(join(neighbor, "SKILL.md"), "third party");
    const extra = join(f.kit, "local-notes.txt");
    fs.writeFileSync(extra, "keep");
    expect(f.run("add", { readKit: () => "new kit" }).preservedExtras).toEqual(["local-notes.txt"]);
    expect(f.run("remove").preservedExtras).toEqual(["local-notes.txt"]);
    expect(fs.readFileSync(extra, "utf8")).toBe("keep");
    expect(fs.readFileSync(join(neighbor, "SKILL.md"), "utf8")).toBe("third party");
    expect(fs.existsSync(f.file)).toBe(false);
    expect(fs.existsSync(f.marker)).toBe(false);
  });
  it("refuses malformed or forged ownership without using manifest paths", () => {
    const f = fixture();
    f.run("add");
    const outside = join(f.root, "outside.txt");
    fs.writeFileSync(outside, "keep");
    for (const body of [
      "{",
      JSON.stringify({ schema: 1, owner: "someone-else", file: outside, sha256: "0".repeat(64) }),
    ]) {
      fs.writeFileSync(f.marker, body);
      expect(caught(() => f.run("remove")).code).toBe("conflict");
      expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    }
  });
  it("rejects managed junctions/symlinks and relative/root destinations", () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(f.skills);
    fs.writeFileSync(join(outside, "SKILL.md"), "keep");
    fs.symlinkSync(outside, f.kit, "junction");
    expect(caught(() => f.run("add")).code).toBe("unsafe-path");
    expect(caught(() => f.run("remove")).code).toBe("unsafe-path");
    expect(fs.readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("keep");
    for (const skillsDirectory of ["relative", resolve("/")])
      expect(
        caught(() => manageSkillInstallation({ action: "remove", skillsDirectory })).code,
      ).toBe("unsafe-path");
  });
  it("rejects symlinks at the skill file and manifest without touching their targets", () => {
    for (const target of ["file", "marker"] as const) {
      const f = fixture();
      f.run("add");
      const path = f[target];
      const outside = join(f.root, "outside");
      fs.mkdirSync(outside);
      fs.unlinkSync(path);
      fs.symlinkSync(outside, path, "junction");
      expect(caught(() => f.run("remove")).code).toBe("unsafe-path");
      expect(fs.existsSync(outside)).toBe(true);
    }
  });
  it("locks the normalized physical destination without takeover and releases ownership", () => {
    const f = fixture();
    let nested: ManagedInstallError | undefined;
    f.run("add", {
      readKit: () => {
        nested = caught(() =>
          manageSkillInstallation({
            action: "add",
            skillsDirectory: join(f.skills, "..", "skills"),
          }),
        );
        return "fixture kit";
      },
    });
    expect(nested?.code).toBe("busy");
    expect((nested?.cause as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(f.run("add", { readKit: () => "fixture kit" }).status).toBe("noop");
    const lock = join(f.skills, ".use-lohra-ts.lohra.lock");
    fs.writeFileSync(lock, "old lock");
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(caught(() => f.run("remove")).code).toBe("busy");
    expect(fs.readFileSync(lock, "utf8")).toBe("old lock");
  });
  it("reports partial publication and preserves its original cause", () => {
    const f = fixture();
    const original = new Error("fixture publication failure");
    const operations = {
      fs: {
        ...fs,
        renameSync: (source: fs.PathLike, destination: fs.PathLike) => {
          if (String(destination) === f.marker) throw original;
          fs.renameSync(source, destination);
        },
      },
    };
    const error = caught(() => f.run("add", operations));
    expect(error.code).toBe("partial");
    expect(error.cause === original).toBe(true);
    expect(error.message).toContain("partial");
    expect(caught(() => f.run("add")).code).toBe("conflict");
  });
  it("keeps primary and cleanup causes visible without deleting another writer's lock", () => {
    const f = fixture();
    const primary = new Error("fixture read failure");
    const cleanup = new Error("fixture cleanup failure");
    const error = caught(() =>
      f.run("add", {
        readKit: () => {
          throw primary;
        },
        fs: {
          ...fs,
          unlinkSync: () => {
            throw cleanup;
          },
        },
      }),
    );
    expect(error.cause).toBeInstanceOf(AggregateError);
    const causes = (error.cause as AggregateError).errors as unknown[];
    expect(causes.includes(primary)).toBe(true);
    expect(causes.includes(cleanup)).toBe(true);
    expect(fs.readFileSync(join(f.skills, ".use-lohra-ts.lohra.lock"), "utf8")).toContain("holder");
  });
});
