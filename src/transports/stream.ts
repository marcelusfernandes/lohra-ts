import type { StreamCallbacks } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

interface Slot {
  id: string | null;
  name: string;
  arguments: string;
}

export function assembleStreamedResponse(
  chunks: Iterable<unknown>,
  callbacks: StreamCallbacks = {},
): Record<string, unknown> {
  const content: string[] = [];
  const slots = new Map<unknown, Slot>();
  const order: unknown[] = [];
  let finishReason: string | null = null;
  let usage: unknown = null;

  for (const rawChunk of chunks) {
    const chunk = record(rawChunk);
    if (chunk.usage !== null && chunk.usage !== undefined) usage = chunk.usage;
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;
    const choice = record(chunk.choices[0]);
    const delta = record(choice.delta);
    if (typeof delta.content === "string" && delta.content) {
      content.push(delta.content);
      callbacks.onText?.(delta.content);
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content)
      callbacks.onReasoning?.(delta.reasoning_content);

    const rawCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawCall of rawCalls) {
      const call = record(rawCall);
      let key = call.index ?? call.id;
      if (key === null || key === undefined) key = order.at(-1) ?? 0;
      if (!slots.has(key)) {
        slots.set(key, { id: null, name: "", arguments: "" });
        order.push(key);
      }
      const slot = slots.get(key);
      if (slot === undefined) throw new Error("stream slot disappeared");
      const fn = record(call.function);
      if (typeof call.id === "string" && call.id) slot.id = call.id;
      if (typeof fn.name === "string" && fn.name) slot.name = fn.name;
      if (typeof fn.arguments === "string" && fn.arguments) slot.arguments += fn.arguments;
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason)
      finishReason = choice.finish_reason;
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content.join("") || null,
  };
  const toolCalls = order.flatMap((key) => {
    const slot = slots.get(key);
    return slot?.id && slot.name
      ? [
          {
            id: slot.id,
            type: "function",
            function: { name: slot.name, arguments: slot.arguments },
          },
        ]
      : [];
  });
  const toolFinish = finishReason === "tool_calls" || finishReason === "function_call";
  if (toolFinish && (toolCalls.length === 0 || toolCalls.length !== slots.size))
    throw new Error("incomplete tool-call stream");
  if (slots.size > 0 && !toolFinish) {
    callbacks.onWarning?.(
      `discarding ${String(slots.size)} orphaned tool-call stream slot(s); finish_reason=${JSON.stringify(finishReason)}`,
    );
  } else if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    choices: [{ message, finish_reason: finishReason }],
    usage,
  };
}
