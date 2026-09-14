import type { SystemBands } from "../transports/index.js";
import type { ConversationRepository, StoredSession } from "./types.js";

export interface ResolveTurnSessionInput {
  readonly repository: ConversationRepository;
  /** `input.sessionId` from `runTurn`'s own caller, untouched — `undefined`
   * means the caller left session selection to `idSource` below. Needed
   * (not just the resolved id) to reproduce the pre-#649 rule verbatim: an
   * EXPLICIT id that doesn't resolve is `SESSION_NOT_FOUND`; an id this
   * function minted itself never is. */
  readonly sessionId: string | undefined;
  readonly idSource: () => string;
  readonly promptSnapshot: () => string | SystemBands;
  readonly model: string;
  readonly cwd: string;
}

export interface ResolveTurnSessionResult {
  readonly sessionId: string;
  readonly session: StoredSession;
  readonly created: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function resolveTurnSession(input: ResolveTurnSessionInput): ResolveTurnSessionResult {
  throw new Error("not implemented: resolveTurnSession");
}
