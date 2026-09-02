/** POST /v1/chat/completions — mirrors `lohra/server/app.py::chat_completions`.
 * Pipeline order is load-bearing (contract v2 decision 2 / assertions 20/22):
 * body parse+schema (422) -> auth (401) -> content validation (400, before
 * any SSE byte) -> dispatch. */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { authorized } from "./auth.js";
import {
  buildChatCompletion,
  buildChunk,
  buildDone,
  buildUsageChunk,
  CompletionError,
  splitChatMessages,
  UpstreamError,
  sseEvent,
} from "./chat-format.js";
import { readBody, startSse, writeJson } from "./http-io.js";
import { isPythonTruthy } from "./python-truthy.js";
import {
  parseRequestBody,
  validateChatBody,
  validationErrorBody,
  ValidationError,
} from "./request-validation.js";
import type { CompletionService } from "./service.js";

export interface ChatHandlerDeps {
  readonly service: CompletionService;
  readonly apiKey: string | null;
}

export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ChatHandlerDeps,
): Promise<void> {
  const raw = await readBody(req);
  const contentType = req.headers["content-type"];

  let parsed;
  try {
    const value = parseRequestBody(raw, contentType);
    parsed = validateChatBody(value);
  } catch (error) {
    if (error instanceof ValidationError) {
      writeJson(res, 422, validationErrorBody(error.details));
      return;
    }
    throw error;
  }

  if (!authorized(req.headers.authorization, deps.apiKey)) {
    writeJson(res, 401, {
      error: { message: "missing or invalid API key", type: "authentication_error" },
    });
    return;
  }

  let split;
  try {
    split = splitChatMessages(parsed.messages);
  } catch (error) {
    if (error instanceof CompletionError) {
      writeJson(res, 400, { error: { message: error.message, type: "invalid_request_error" } });
      return;
    }
    throw error;
  }

  const completionId = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const includeUsage = isPythonTruthy(parsed.streamOptions?.["include_usage"]);

  if (parsed.stream) {
    startSse(res);
    res.write(
      sseEvent(buildChunk({ completionId, model: parsed.model, delta: { role: "assistant" }, created })),
    );
    try {
      const result = await deps.service.run({
        model: parsed.model,
        history: split.history,
        userText: split.lastUserText,
        usageMessages: parsed.messages,
        temperature: parsed.temperature,
        maxTokens: parsed.maxTokens,
        onDelta: (delta) => {
          res.write(
            sseEvent(buildChunk({ completionId, model: parsed.model, delta: { content: delta }, created })),
          );
        },
      });
      res.write(
        sseEvent(
          buildChunk({
            completionId,
            model: parsed.model,
            delta: {},
            created,
            finishReason: result.finishReason,
          }),
        ),
      );
      if (includeUsage) {
        res.write(sseEvent(buildUsageChunk({ completionId, model: parsed.model, created, usage: result.usage })));
      }
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      res.write(sseEvent({ error: { message: error.message, type: "upstream_error" } }));
    }
    res.write(buildDone());
    res.end();
    return;
  }

  try {
    const result = await deps.service.run({
      model: parsed.model,
      history: split.history,
      userText: split.lastUserText,
      usageMessages: parsed.messages,
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
    });
    writeJson(
      res,
      200,
      buildChatCompletion({
        completionId,
        model: result.model,
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
        created,
      }),
    );
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    writeJson(res, 502, { error: { message: error.message, type: "upstream_error" } });
  }
}
