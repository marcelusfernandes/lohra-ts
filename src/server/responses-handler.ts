/** POST /v1/responses — mirrors `lohra/server/app.py::responses`. Same
 * pipeline order as chat (body parse+schema 422 -> auth 401 -> content
 * validation 400 -> dispatch); reuses splitChatMessages for the exact same
 * "must not be empty" / "last message must be a user message" check the
 * oracle re-applies to the already-parsed Responses input. */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { authorized } from "./auth.js";
import { CompletionError, splitChatMessages, UpstreamError } from "./chat-format.js";
import { readBody, startSse, writeJson } from "./http-io.js";
import {
  parseRequestBody,
  validateResponsesBody,
  validationErrorBody,
  ValidationError,
} from "./request-validation.js";
import {
  buildContentPartAddedEvent,
  buildOutputItemAddedEvent,
  buildResponseCompletedEvent,
  buildResponseCreatedEvent,
  buildResponseFailedEvent,
  buildResponseObject,
  buildTextDeltaEvent,
  parseResponsesInput,
} from "./responses-format.js";
import type { CompletionService } from "./service.js";

export interface ResponsesHandlerDeps {
  readonly service: CompletionService;
  readonly apiKey: string | null;
}

class SequenceCounter {
  #next = 0;

  public next(): number {
    const value = this.#next;
    this.#next += 1;
    return value;
  }
}

export async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ResponsesHandlerDeps,
): Promise<void> {
  const raw = await readBody(req);
  const contentType = req.headers["content-type"];

  let parsed;
  try {
    const value = parseRequestBody(raw, contentType);
    parsed = validateResponsesBody(value);
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

  let messages;
  let split;
  try {
    messages = parseResponsesInput(parsed.input, parsed.instructions);
    split = splitChatMessages(messages);
  } catch (error) {
    if (error instanceof CompletionError) {
      writeJson(res, 400, { error: { message: error.message, type: "invalid_request_error" } });
      return;
    }
    throw error;
  }

  const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);

  if (parsed.stream) {
    startSse(res);
    const seq = new SequenceCounter();
    res.write(
      buildResponseCreatedEvent({
        responseId,
        model: parsed.model,
        created,
        sequenceNumber: seq.next(),
      }),
    );
    res.write(buildOutputItemAddedEvent({ responseId, sequenceNumber: seq.next() }));
    res.write(buildContentPartAddedEvent({ responseId, sequenceNumber: seq.next() }));
    try {
      const result = await deps.service.run({
        model: parsed.model,
        history: split.history,
        userText: split.lastUserText,
        usageMessages: messages,
        temperature: parsed.temperature,
        maxTokens: parsed.maxOutputTokens,
        onDelta: (delta) => {
          res.write(buildTextDeltaEvent({ responseId, delta, sequenceNumber: seq.next() }));
        },
      });
      res.write(
        buildResponseCompletedEvent(
          buildResponseObject({
            responseId,
            model: result.model,
            content: result.content,
            status: "completed",
            usage: result.usage,
            created,
          }),
          { sequenceNumber: seq.next() },
        ),
      );
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      const failed = buildResponseObject({
        responseId,
        model: parsed.model,
        content: "",
        status: "failed",
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
        created,
        error: { code: "server_error", message: error.message },
      });
      res.write(buildResponseFailedEvent(failed, { sequenceNumber: seq.next() }));
    }
    res.end();
    return;
  }

  try {
    const result = await deps.service.run({
      model: parsed.model,
      history: split.history,
      userText: split.lastUserText,
      usageMessages: messages,
      temperature: parsed.temperature,
      maxTokens: parsed.maxOutputTokens,
    });
    writeJson(
      res,
      200,
      buildResponseObject({
        responseId,
        model: result.model,
        content: result.content,
        status: "completed",
        usage: result.usage,
        created,
      }),
    );
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    writeJson(res, 502, { error: { message: error.message, type: "upstream_error" } });
  }
}
