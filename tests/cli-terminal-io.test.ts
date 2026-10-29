import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import { terminalInput } from "../src/cli/terminal-io.js";

function fixture(tty = true) {
  const stream = Object.assign(new PassThrough(), {
    isTTY: tty,
    isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) {
      this.isRaw = value;
    }),
  });
  return { stream, input: terminalInput(stream as unknown as ReadStream, true) };
}

describe("terminal input", () => {
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
  it.each(["\u0003", "\u0004"])("rejects cancellation/EOF explicitly", async (byte) => {
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
