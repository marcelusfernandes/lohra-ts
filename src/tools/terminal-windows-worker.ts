import { executeTerminalPty } from "./terminal.js";
import type { ToolArguments } from "./types.js";

const REQUEST_LIMIT = 64 * 1024;

function frame(value: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    const bytes = chunk as Buffer;
    if (input.length + bytes.length > REQUEST_LIMIT) throw new Error("request exceeds 65536 bytes");
    input = Buffer.concat([input, bytes]);
  }
  const parsed = JSON.parse(input.toString("utf8")) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 3 ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("args" in parsed) ||
    parsed.args === null ||
    typeof parsed.args !== "object" ||
    Array.isArray(parsed.args) ||
    !("timeoutKind" in parsed) ||
    (parsed.timeoutKind !== null && parsed.timeoutKind !== "int" && parsed.timeoutKind !== "float")
  ) {
    throw new Error("invalid request schema");
  }
  const args = parsed.args as ToolArguments;
  if (
    typeof args.command !== "string" ||
    args.command.length === 0 ||
    (args.cwd !== undefined && args.cwd !== null && typeof args.cwd !== "string") ||
    (args.timeout !== undefined &&
      args.timeout !== null &&
      typeof args.timeout !== "boolean" &&
      (typeof args.timeout !== "number" || !Number.isFinite(args.timeout))) ||
    Object.keys(args).some((key) => key !== "command" && key !== "cwd" && key !== "timeout")
  ) {
    throw new Error("invalid command schema");
  }
  frame({ type: "ready" });
  const result = await executeTerminalPty(args, parsed.timeoutKind);
  frame({ type: "result", value: result });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  frame({ type: "fault", message: message.slice(0, 500) });
  process.exitCode = 1;
});
