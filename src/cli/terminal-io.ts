import type { ReadStream } from "node:tty";

export class TerminalInputError extends Error {}

export interface TerminalInput {
  readonly isTty: boolean;
  start(): void;
  readonly readLine: () => Promise<string>;
  close(): void;
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
  let bytes: number[] = [];
  let total = 0;
  let reads = 0;
  let afterCr = false;
  const lines: string[] = [];
  let pending:
    | {
        resolve(value: string): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

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
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure ?? new Error("terminal input closed"));
      pending = undefined;
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
  function data(chunk: Buffer | string): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > 65536) {
      fail("terminal input session limit exceeded");
      return;
    }
    for (const byte of buffer) {
      if (byte === 3) {
        interrupt();
        return;
      }
      if (byte === 4 || byte === 26) {
        end();
        return;
      }
      if (byte === 10 && afterCr) {
        afterCr = false;
        continue;
      }
      afterCr = byte === 13;
      if (byte === 10 || byte === 13) {
        const line = Buffer.from(bytes).toString("utf8");
        try {
          write("\n");
        } catch (cause) {
          fail("terminal prompt output failed", cause);
          return;
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
            return;
          }
        }
      } else if (byte === 8 || byte === 127) {
        // Remove one UTF-8 code point, including continuation bytes.
        while (bytes.length && ((bytes[bytes.length - 1] ?? 0) & 0xc0) === 0x80) bytes.pop();
        bytes.pop();
      } else if (byte >= 32) {
        bytes.push(byte);
        if (bytes.length > 4096) {
          fail("terminal input line limit exceeded");
          return;
        }
      } else {
        fail("terminal input contains unsupported control characters");
        return;
      }
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
      if (++reads > 32) {
        throw fail("terminal input question limit exceeded");
      }
      if (pending) throw new Error("terminal input already reading");
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
    close,
  };
}
