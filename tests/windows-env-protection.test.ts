import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { atomicWritePrivate0600, type AtomicWriteOperations } from "../src/auth/json-file.js";
import { upsertEnvFile, type EnvWriteOperations } from "../src/onboarding/env-write.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lohra-env-fake-"));
  roots.push(root);
  const path = join(root, ".env");
  let content: string | null = null;
  const events: string[] = [];
  const legacy = () => {
    throw new Error("legacy writer must not run on Windows");
  };
  const operations: EnvWriteOperations = {
    platform: "win32",
    readText: () => {
      if (content === null) throw Object.assign(new Error("missing fake .env"), { code: "ENOENT" });
      return content;
    },
    privateWrite: (_path, body) => {
      events.push("private-write");
      content = body;
    },
    writeText: legacy,
    chmod600: legacy,
    replace: legacy,
  };
  return {
    root,
    path,
    operations,
    events,
    content: () => content,
    setContent: (value: string) => {
      content = value;
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const child = join(root, "privado café");
    if (existsSync(child)) rmdirSync(child);
    rmdirSync(root);
  }
});

describe("Windows .env protection integration", () => {
  it("protects destination and temporary before the first byte and verifies rename", () => {
    const state = fixture();
    const events: string[] = [];
    let persisted = "";
    const atomic: AtomicWriteOperations = {
      platform: "win32",
      pid: 17,
      now: () => 23,
      mkdir: () => {
        throw new Error("Windows must not use recursive mkdir");
      },
      open: () => {
        throw new Error("Windows must use the protected descriptor");
      },
      prepare: (path) => {
        events.push(`protect:${path}`);
        return {
          verifyBeforeWrite: () => undefined,
          openOwnedForWrite: () => {
            events.push(`open:${path}`);
            return 7;
          },
          verifyBeforePublication: (source) => {
            events.push(`before-rename:${source}`);
          },
          verifyAfterPublication: () => {
            events.push("after-rename");
          },
          removeOwned: () => {
            events.push(`remove:${path}`);
          },
        };
      },
      write: (_descriptor, bytes, offset) => {
        events.push("first-byte");
        persisted += bytes.subarray(offset).toString("utf8");
        return bytes.length - offset;
      },
      fsync: () => {
        events.push("fsync");
      },
      close: () => {
        events.push("close");
      },
      rename: () => {
        events.push("rename");
      },
      unlink: () => {
        throw new Error("unexpected generic cleanup");
      },
    };
    const operations: EnvWriteOperations = {
      ...state.operations,
      privateWrite: (path, body) => {
        atomicWritePrivate0600(path, body, atomic);
      },
    };
    expect(upsertEnvFile(state.path, { OPENAI_API_KEY: "fictional" }, operations)).toEqual([
      "OPENAI_API_KEY",
    ]);
    expect(persisted).toBe("OPENAI_API_KEY=fictional\n");
    expect(events.slice(0, 2)).toEqual([
      `protect:${state.path}`,
      `protect:${state.path}.tmp-17-23`,
    ]);
    expect(events.indexOf("first-byte")).toBeGreaterThan(
      events.indexOf(`open:${state.path}.tmp-17-23`),
    );
    expect(events.indexOf("first-byte")).toBeLessThan(events.indexOf("rename"));
    expect(events.indexOf("fsync")).toBeLessThan(events.indexOf("rename"));
    expect(events.indexOf("before-rename:" + `${state.path}.tmp-17-23`)).toBeLessThan(
      events.indexOf("rename"),
    );
    expect(events.at(-1)).toBe("after-rename");
  });

  it("passes rendered fictitious keys to the private writer and keeps comments and idempotence", () => {
    const state = fixture();
    state.setContent(
      "# keep\nOPENAI_API_KEY=fictional-old\nOTHER=x\nexport OPENAI_API_KEY=duplicate\n",
    );
    const updates = { OPENAI_API_KEY: "fictional two words", NEW_VALUE: "hash#fictional" };
    expect(upsertEnvFile(state.path, updates, state.operations)).toEqual([
      "OPENAI_API_KEY",
      "NEW_VALUE",
    ]);
    expect(state.content()).toBe(
      '# keep\nOPENAI_API_KEY="fictional two words"\nOTHER=x\nNEW_VALUE="hash#fictional"\n',
    );
    expect(upsertEnvFile(state.path, updates, state.operations)).toEqual([]);
    expect(state.events).toEqual(["private-write"]);
  });

  it("does not create a Windows directory before the private writer prepares it", () => {
    const state = fixture();
    const directory = join(state.root, "privado café");
    const path = join(directory, ".env");
    const operations: EnvWriteOperations = {
      ...state.operations,
      privateWrite: (_path, body) => {
        expect(existsSync(directory)).toBe(false);
        expect(body).toBe("OPENAI_API_KEY=fictional\n");
      },
    };
    expect(upsertEnvFile(path, { OPENAI_API_KEY: "fictional" }, operations)).toEqual([
      "OPENAI_API_KEY",
    ]);
  });

  it("propagates non-ENOENT reads without writing or exposing a value", () => {
    const state = fixture();
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
    const operations: EnvWriteOperations = {
      ...state.operations,
      readText: () => {
        throw denied;
      },
    };
    try {
      upsertEnvFile(state.path, { OPENAI_API_KEY: "fictional-secret" }, operations);
      throw new Error("expected .env read failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/read.*\.env|\.env.*read/i);
      expect((error as Error).message).not.toContain("fictional-secret");
      expect((error as Error).cause).toBe(denied);
    }
    expect(state.events).toEqual([]);
  });

  it("reports a pre-publication failure while preserving the previous text", () => {
    const state = fixture();
    state.setContent("# keep\nOPENAI_API_KEY=fictional-old\n");
    const protectionFailure = new Error("incompatible ACL");
    const operations: EnvWriteOperations = {
      ...state.operations,
      privateWrite: () => {
        throw protectionFailure;
      },
    };
    try {
      upsertEnvFile(state.path, { OPENAI_API_KEY: "fictional-new" }, operations);
      throw new Error("expected .env protection failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(".env");
      expect((error as Error).message).not.toContain("fictional-new");
      expect((error as Error).cause).toBe(protectionFailure);
    }
    expect(state.content()).toBe("# keep\nOPENAI_API_KEY=fictional-old\n");
  });

  it("retains the writer's cleanup cause without including the fictitious value", () => {
    const state = fixture();
    state.setContent("OPENAI_API_KEY=fictional-old\n");
    const primary = new Error("protection failed");
    const cleanup = new Error("owned stage cleanup failed");
    const combined = new AggregateError([primary, cleanup], "write and cleanup failed", {
      cause: primary,
    });
    const operations: EnvWriteOperations = {
      ...state.operations,
      privateWrite: () => {
        throw combined;
      },
    };
    try {
      upsertEnvFile(state.path, { OPENAI_API_KEY: "fictional-new" }, operations);
      throw new Error("expected cleanup failure");
    } catch (error) {
      expect((error as Error).message).not.toContain("fictional-new");
      expect((error as Error).cause).toBe(combined);
      expect(combined.errors).toEqual([primary, cleanup]);
    }
    expect(state.content()).toBe("OPENAI_API_KEY=fictional-old\n");
  });

  it("reports post-publication verification failure without claiming a rollback", () => {
    const state = fixture();
    state.setContent("OPENAI_API_KEY=fictional-old\n");
    const verificationFailure = new Error("post-rename verification failed");
    const operations: EnvWriteOperations = {
      ...state.operations,
      privateWrite: (_path, body) => {
        state.setContent(body);
        throw verificationFailure;
      },
    };
    try {
      upsertEnvFile(state.path, { OPENAI_API_KEY: "fictional-new" }, operations);
      throw new Error("expected .env post-publication failure");
    } catch (error) {
      expect((error as Error).cause).toBe(verificationFailure);
    }
    expect(state.content()).toBe("OPENAI_API_KEY=fictional-new\n");
  });
});
