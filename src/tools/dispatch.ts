import type { RegistryDispatch, ToolArguments, ToolHandler } from "./types.js";
import { parseToolArguments } from "./arguments.js";

export interface RawToolCall {
  readonly id: string | null;
  readonly name: string;
  readonly arguments: string;
}

export class RegistryToolDispatcher {
  constructor(private readonly baseDispatch: RegistryDispatch) {}

  async dispatchCall(call: RawToolCall): Promise<Readonly<Record<string, unknown>>> {
    const content = await this.baseDispatch(call.name, parseToolArguments(call.arguments));
    return Object.freeze({
      role: "tool",
      tool_call_id: call.id,
      name: call.name,
      content,
    });
  }

  dispatch(call: RawToolCall): Promise<Readonly<Record<string, unknown>>> {
    return this.dispatchCall(call);
  }
}

export function composeDispatch(
  base: RegistryDispatch,
  intercepts: Readonly<Record<string, ToolHandler>>,
): (name: string, args: ToolArguments) => Promise<string> {
  return async function composed(name, args) {
    if (arguments.length > 2) {
      throw new TypeError("composed dispatch does not accept keyword arguments");
    }
    const intercept = intercepts[name];
    return intercept === undefined ? base(name, args) : await intercept(args);
  };
}

export async function runBounded<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("bounded dispatch limit must be positive");
  const results = new Array<R>(values.length);
  let next = 0;
  const consume = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await worker(value, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => consume()));
  return results;
}
