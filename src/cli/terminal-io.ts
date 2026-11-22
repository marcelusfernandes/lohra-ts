import type { ReadStream } from "node:tty";

export class TerminalInputError extends Error {}

export type TerminalKey =
  | { readonly kind: "up" | "down" | "left" | "right" | "space" | "enter" | "backspace" }
  | { readonly kind: "char"; readonly value: string };

export interface TerminalInput {
  readonly isTty: boolean;
  start(): void;
  readonly readLine: () => Promise<string>;
  readonly readKey: () => Promise<TerminalKey>;
  close(): void;
}

type InputMode = "line" | "key";

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Lazy, silent terminal input: no handles or raw mode until the first prompt. */
export function terminalInput(
  input: ReadStream = process.stdin,
  outputTty = process.stderr.isTTY,
  write: (value: string) => void = (value) => {
    process.stderr.write(value);
  },
): TerminalInput {
  const isTrue = (value: unknown): boolean => value === true;
  const isTty = isTrue(input.isTTY) && isTrue(outputTty);
  const originalRaw = isTrue(input.isRaw);
  let started = false;
  let closed = false;
  let failure: Error | undefined;
  let mode: InputMode = "line";
  let bytes: number[] = [];
  let total = 0;
  let reads = 0;
  let keyReads = 0;
  let afterCr = false;
  let sequence: number[] | undefined;
  const lines: string[] = [];
  let keys: TerminalKey[] = [];
  let pending: Waiter<string> | undefined;
  let pendingKey: Waiter<TerminalKey> | undefined;

  let cleanupError: TerminalInputError | undefined;
  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (started) {
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", error);
      process.removeListener("SIGINT", interrupt);
      try {
        input.pause();
        input.setRawMode(originalRaw);
      } catch (cause) {
        cleanupError = new TerminalInputError("terminal input restoration failed", { cause });
        failure = cleanupError;
      }
    }
    bytes = [];
    lines.length = 0;
    keys = [];
    sequence = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure ?? new Error("terminal input closed"));
      pending = undefined;
    }
    if (pendingKey) {
      clearTimeout(pendingKey.timer);
      pendingKey.reject(failure ?? new Error("terminal input closed"));
      pendingKey = undefined;
    }
  }
  function close(): void {
    cleanup();
    if (cleanupError) throw cleanupError;
  }
  function checkFailure(): void {
    if (failure) throw failure;
  }
  function fail(message: string, cause?: unknown): TerminalInputError {
    const error = new TerminalInputError(message, { cause });
    failure = error;
    cleanup();
    return error;
  }
  function end(): void {
    fail("terminal input ended (EOF); configuration interrupted");
  }
  function error(cause: unknown): void {
    fail("terminal input failed; configuration interrupted", cause);
  }
  function interrupt(): void {
    fail("terminal input cancelled; configuration interrupted");
  }
  function useMode(next: InputMode): void {
    if (mode === next) return;
    if (bytes.length > 0 || lines.length > 0 || keys.length > 0 || sequence !== undefined) {
      throw fail("terminal input mode changed with pending input");
    }
    mode = next;
  }
  function pushKey(key: TerminalKey): boolean {
    if (pendingKey) {
      const waiter = pendingKey;
      pendingKey = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(key);
      return true;
    }
    keys.push(key);
    if (keys.length > 32) {
      fail("terminal input queue limit exceeded");
      return false;
    }
    return true;
  }
  function arrowKey(byte: number): TerminalKey | "invalid" {
    switch (byte) {
      case 0x41:
        return { kind: "up" };
      case 0x42:
        return { kind: "down" };
      case 0x43:
        return { kind: "right" };
      case 0x44:
        return { kind: "left" };
      default:
        return "invalid";
    }
  }
  function classifySequence(seq: readonly number[]): TerminalKey | "need-more" | "invalid" {
    const second = seq[1];
    if (second === undefined) return "need-more";
    if (second !== 0x5b && second !== 0x4f) return "invalid";
    if (seq.length < 3) return "need-more";
    if (second === 0x4f) {
      if (seq.length > 3) return "invalid";
      return arrowKey(seq[2] ?? 0);
    }
    const last = seq[seq.length - 1] ?? 0;
    if (last >= 0x40 && last <= 0x7e) return arrowKey(last);
    if (seq.length >= 16) return "invalid";
    if (last >= 0x20 && last <= 0x3f) return "need-more";
    return "invalid";
  }
  function keyByte(byte: number): boolean {
    if (byte === 3) {
      sequence = undefined;
      interrupt();
      return false;
    }
    if (byte === 4 || byte === 26) {
      sequence = undefined;
      end();
      return false;
    }
    if (sequence) {
      sequence = [...sequence, byte];
      const classified = classifySequence(sequence);
      if (classified === "need-more") return true;
      sequence = undefined;
      if (classified === "invalid") {
        fail("terminal input contains unsupported control characters");
        return false;
      }
      return pushKey(classified);
    }
    if (byte === 27) {
      sequence = [27];
      return true;
    }
    if (byte === 10 && afterCr) {
      afterCr = false;
      return true;
    }
    afterCr = byte === 13;
    if (byte === 10 || byte === 13) return pushKey({ kind: "enter" });
    if (byte === 32) return pushKey({ kind: "space" });
    if (byte === 8 || byte === 127) return pushKey({ kind: "backspace" });
    if (byte >= 33 && byte <= 126)
      return pushKey({ kind: "char", value: String.fromCharCode(byte) });
    fail("terminal input contains unsupported control characters");
    return false;
  }
  function lineByte(byte: number): boolean {
    if (byte === 3) {
      interrupt();
      return false;
    }
    if (byte === 4 || byte === 26) {
      end();
      return false;
    }
    if (byte === 10 && afterCr) {
      afterCr = false;
      return true;
    }
    afterCr = byte === 13;
    if (byte === 10 || byte === 13) {
      const line = Buffer.from(bytes).toString("utf8");
      try {
        write("\n");
      } catch (cause) {
        fail("terminal prompt output failed", cause);
        return false;
      }
      bytes = [];
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(line);
        pending = undefined;
      } else {
        lines.push(line);
        if (lines.length > 32) {
          fail("terminal input queue limit exceeded");
          return false;
        }
      }
      return true;
    }
    if (byte === 8 || byte === 127) {
      // Remove one UTF-8 code point, including continuation bytes.
      while (bytes.length && ((bytes[bytes.length - 1] ?? 0) & 0xc0) === 0x80) bytes.pop();
      bytes.pop();
      return true;
    }
    if (byte >= 32) {
      bytes.push(byte);
      if (bytes.length > 4096) {
        fail("terminal input line limit exceeded");
        return false;
      }
      return true;
    }
    fail("terminal input contains unsupported control characters");
    return false;
  }
  function data(chunk: Buffer | string): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > 65536) {
      fail("terminal input session limit exceeded");
      return;
    }
    for (const byte of buffer) {
      if (!(mode === "key" ? keyByte(byte) : lineByte(byte))) return;
    }
  }
  function start(): void {
    if (started || !isTty || closed) return;
    try {
      input.setRawMode(true);
      started = true;
      input.on("data", data);
      input.on("end", end);
      input.on("error", error);
      process.on("SIGINT", interrupt);
      input.resume();
      write("Input is hidden. Press Enter to submit; Ctrl+C to cancel.\n");
    } catch (cause) {
      fail("terminal input failed; configuration interrupted", cause);
      throw new TerminalInputError("terminal input failed; configuration interrupted", { cause });
    }
  }
  return {
    isTty,
    start,
    async readLine() {
      if (!isTty) throw new Error("terminal input requires a TTY");
      checkFailure();
      if (closed) throw new Error("terminal input closed");
      if (pending || pendingKey) throw new Error("terminal input already reading");
      useMode("line");
      if (++reads > 32) {
        throw fail("terminal input question limit exceeded");
      }
      start();
      checkFailure();
      if (lines.length) return lines.shift() as string;
      const answer = await new Promise<string>((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(() => {
            fail("terminal input timed out; configuration interrupted");
          }, 300000),
        };
      });
      checkFailure();
      return answer;
    },
    async readKey() {
      if (!isTty) throw new Error("terminal input requires a TTY");
      checkFailure();
      if (closed) throw new Error("terminal input closed");
      if (pending || pendingKey) throw new Error("terminal input already reading");
      useMode("key");
      if (++keyReads > 1024) throw fail("terminal input key limit exceeded");
      start();
      checkFailure();
      if (keys.length) return keys.shift() as TerminalKey;
      const answer = await new Promise<TerminalKey>((resolve, reject) => {
        pendingKey = {
          resolve,
          reject,
          timer: setTimeout(() => {
            fail("terminal input timed out; configuration interrupted");
          }, 300000),
        };
      });
      checkFailure();
      return answer;
    },
    close,
  };
}
