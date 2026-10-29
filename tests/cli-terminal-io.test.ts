import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import { TerminalInputError, terminalInput } from "../src/cli/terminal-io.js";

function fixture(tty = true) {
  const stream = Object.assign(new PassThrough(), {
    isTTY: tty,
    isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) {
      this.isRaw = value;
    }),
  });
  return { stream, input: terminalInput(stream as unknown as ReadStream, true, () => undefined) };
}

describe("terminal input", () => {
  it("preserves the newline writer failure cause without exposing its message", async () => {
    const { stream, input: unused } = fixture();
    unused.close();
    const original = new Error("fixture-private-output-detail");
    const input = terminalInput(stream as unknown as ReadStream, true, (value) => {
      if (value === "\n") throw original;
    });
    try {
      const pending = input.readLine();
      stream.write("fixture-answer\r");
      const failure: unknown = await pending.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TerminalInputError);
      if (!(failure instanceof TerminalInputError)) throw new Error("expected terminal failure");
      expect(failure.message).toBe("terminal prompt output failed");
      expect(failure.cause === original).toBe(true);
      expect(String(failure).includes(original.message)).toBe(false);
      expect(stream.isRaw).toBe(false);
      expect(stream.listenerCount("data")).toBe(0);
    } finally {
      input.close();
    }
  });
  it("settles pending input even when raw mode restoration fails", async () => {
    const { stream, input } = fixture();
    const pending = input.readLine();
    stream.setRawMode.mockImplementation(() => {
      throw new Error("fixture restoration failure");
    });
    stream.emit("end");
    await expect(pending).rejects.toThrow("restoration failed");
    expect(stream.listenerCount("data")).toBe(0);
    expect(() => {
      input.close();
    }).toThrow("restoration failed");
  });
  it("expires a human-scale five minute idle read and removes its timer", async () => {
    vi.useFakeTimers();
    const { stream, input } = fixture();
    try {
      const pending = input.readLine();
      const rejection = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(300000);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
      expect(stream.isRaw).toBe(false);
    } finally {
      input.close();
      vi.useRealTimers();
    }
  });
  it("rejects an EOF in the same chunk as a submitted answer", async () => {
    const { stream, input } = fixture();
    const pending = input.readLine();
    stream.write("fixture\r\u0004");
    await expect(pending).rejects.toThrow("EOF");
    input.close();
  });
  it("handles SIGINT and restores the original raw mode", async () => {
    const { stream, input } = fixture();
    stream.isRaw = true;
    // The adapter captured false at construction; a separate instance captures true.
    input.close();
    const rawInput = terminalInput(stream as unknown as ReadStream, true, () => undefined);
    const before = process.listenerCount("SIGINT");
    const pending = rawInput.readLine();
    process.emit("SIGINT");
    await expect(pending).rejects.toThrow("cancelled");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(stream.isRaw).toBe(true);
  });
  it("handles Unicode backspace and bounds queued lines and session bytes", async () => {
    const first = fixture();
    const answer = first.input.readLine();
    first.stream.write("cafétr\b\b\b\n");
    expect(await answer).toBe("caf");
    first.input.close();
    for (const chunk of ["\n".repeat(35), "x".repeat(65537)]) {
      const f = fixture();
      const pending = f.input.readLine();
      f.stream.write(chunk);
      await expect(pending).rejects.toThrow("limit");
      f.input.close();
    }
  });
  it("reads real stream bytes without echo and restores raw mode/listeners", async () => {
    const { stream, input } = fixture();
    const pending = input.readLine();
    stream.write("fixture-value\r\nsecond\n");
    expect(await pending).toBe("fixture-value");
    expect(await input.readLine()).toBe("second");
    input.close();
    expect(stream.isRaw).toBe(false);
    expect(stream.listenerCount("data")).toBe(0);
  });
  it.each(["\u0003", "\u0004", "\u001a"])("rejects cancellation/EOF explicitly", async (byte) => {
    const { stream, input } = fixture();
    const pending = input.readLine();
    stream.write(byte);
    await expect(pending).rejects.toThrow(/terminal input/);
    input.close();
    expect(stream.isRaw).toBe(false);
  });
  it("rejects stream failure without exposing its message", async () => {
    const { stream, input } = fixture();
    const pending = input.readLine();
    stream.emit("error", new Error("fixture-sensitive"));
    await expect(pending).rejects.toThrow("terminal input failed");
    input.close();
  });
  it("bounds input and rejects non-TTY reads", async () => {
    const { stream, input } = fixture();
    const pending = input.readLine();
    stream.write("x".repeat(4097));
    await expect(pending).rejects.toThrow(/limit/);
    input.close();
    const nonTty = fixture(false);
    expect(nonTty.input.isTty).toBe(false);
    await expect(nonTty.input.readLine()).rejects.toThrow(/TTY/);
    nonTty.input.close();
  });
});
