import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
