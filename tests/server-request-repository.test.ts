import { describe, expect, it } from "vitest";

import { RequestRepository } from "../src/server/request-repository.js";

describe("RequestRepository — per-request, seeded, discards everything else", () => {
  it("returns the seeded history regardless of session id, and never reports an existing session", () => {
    const history = [{ role: "user", content: "prior" }, { role: "assistant", content: "reply" }];
    const repo = new RequestRepository(history);

    expect(repo.session("anything")).toBeNull();
    expect(repo.loadMessages("anything")).toEqual(history);
    expect(repo.loadMessages("something-else")).toEqual(history);
  });

  it("createSession/commitTurn/commitUsage are no-ops; summary is null", () => {
    const repo = new RequestRepository([]);
    expect(() => {
      repo.createSession({ id: "x", systemPrompt: "s", model: "m", cwd: "/" });
    }).not.toThrow();
    expect(() => {
      repo.commitTurn({
        sessionId: "x",
        user: { role: "user", content: "a" },
        assistant: { role: "assistant", content: "b" },
        usage: null,
        cost: null,
        apiCalls: 1,
      });
    }).not.toThrow();
    expect(repo.summary("x")).toBeNull();
  });

  it("does not leak mutations back into the seed array between calls", () => {
    const seed = [{ role: "user", content: "a" }];
    const repo = new RequestRepository(seed);
    const first = repo.loadMessages("s");
    (first as { role: string; content: string }[]).push({ role: "user", content: "injected" });
    expect(repo.loadMessages("s")).toEqual([{ role: "user", content: "a" }]);
  });
});
