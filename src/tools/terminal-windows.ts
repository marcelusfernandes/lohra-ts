import { executeTerminalPty } from "./terminal.js";
import type { ToolArguments } from "./types.js";

// Red implementation: the caller's cwd is still inherited by ConPTY.
export async function runWindowsTerminalBridge(args: ToolArguments): Promise<string> {
  return executeTerminalPty(args);
}
