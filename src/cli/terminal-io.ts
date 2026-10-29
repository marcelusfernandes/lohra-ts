import type { ReadStream } from "node:tty";
export interface TerminalInput {
  readonly isTty: boolean;
  readLine(): Promise<string>;
  close(): void;
}
export function terminalInput(
  _input: ReadStream = process.stdin,
  _outputTty = process.stderr.isTTY,
): TerminalInput {
  throw new Error("not implemented: terminalInput");
}
