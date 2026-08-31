import type { ModelRequest, ModelTransport } from "../conversation/index.js";
import type { NormalizedResponse } from "../transports/index.js";

/**
 * Wraps a ModelTransport whose underlying client is owned by something
 * other than this turn — a ClientPool entry, or the parent session's own
 * client when a child inherits the default provider — and turns close()
 * into a no-op.
 *
 * ConversationRuntime.runTurn() unconditionally calls transport.close() in
 * its finally block, and every ModelTransport in this codebase
 * (ChatCompletionsModel, AnthropicMessagesModel, ResponsesModel) forwards
 * that straight to the underlying SDK client's own close(). That's correct
 * for the parent's one-transport-per-process-invocation lifecycle, but
 * wrong for a child: each of the child's turns (the initial spawn, plus any
 * steer-driven resurrection) constructs its own ConversationRuntime
 * instance, so without this wrapper every turn after the first would call
 * complete() on an already-closed client. The pool, not any single turn,
 * is what decides when the underlying client actually closes.
 */
export class NonClosingTransport implements ModelTransport {
  public constructor(private readonly inner: ModelTransport) {}

  public complete(request: ModelRequest): Promise<NormalizedResponse> {
    return this.inner.complete(request);
  }

  public close(): void {
    // Deliberately does not call this.inner.close().
  }
}
