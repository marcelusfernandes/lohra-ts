import { describe, expect, it } from "vitest";

import { Emitter } from "../src/core/emitter.js";
import type { ChatEvents } from "../src/events/protocol.js";

describe("Emitter", () => {
  it("delivers typed events and supports unsubscribe", () => {
    const seen: string[] = [];
    const emitter = new Emitter<ChatEvents>();
    const off = emitter.on("delta", (p) => seen.push(p.delta));
    emitter.emit("delta", { sessionId: "s1", delta: "a" });
    off();
    emitter.emit("delta", { sessionId: "s1", delta: "b" });
    expect(seen).toEqual(["a"]);
  });

  it("does not throw when emitting to nobody", () => {
    const emitter = new Emitter<ChatEvents>();
    expect(() => {
      emitter.emit("delta", { sessionId: "s1", delta: "x" });
    }).not.toThrow();
  });
});
