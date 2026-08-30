/** `ConversationRuntime.runTurn` always closes its transport in `finally` —
 * correct for the CLI's one-shot-per-process usage, fatal for an HTTP server
 * sharing one provider client/connection pool across many requests (the
 * client throws CLIENT_CLOSED on the next call). Wrap the shared transport so
 * each per-request runtime's close() is a no-op; the real client closes once,
 * at server shutdown. */

import type { ModelRequest, ModelTransport } from "../conversation/index.js";
import type { NormalizedResponse } from "../transports/index.js";

export class NonClosingTransport implements ModelTransport {
  public constructor(private readonly inner: ModelTransport) {}

  public complete(request: ModelRequest): Promise<NormalizedResponse> {
    return this.inner.complete(request);
  }

  public close(): void {
    // Intentionally not closing the shared transport.
  }
}
