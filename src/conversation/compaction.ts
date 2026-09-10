// Compaction preflight (issue #252, epic #230 "Janela de contexto:
// compactar antes de estourar"). Wires together three pieces built by
// earlier sub-issues that no caller used yet: `resolveContextWindow` (#250),
// `estimateTokens`/`estimateRequestTokens` (#251) and the
// `compression_locks` table + `LockRepository` (scaffolded, never called).
//
// Decision (i) vs (ii) (see the issue body and docs/context-compaction.md):
// this module rewrites the session's history IN PLACE (deactivate the
// summarized rows, insert a summary, reinsert the kept tail so ordering
// stays correct) rather than closing the session with
// `end_reason=compression` and opening a continuation. The `messages.active`
// column already exists for exactly this; a continuation would need a new
// session id to flow back through `--session` resume, the gateway's
// `parent_session_id`/`knownSessionIds` bookkeeping (which currently
// *refuses* linked sessions as "subsession" for prompt submission) and the
// CLI envelope -- much more new surface for the same outcome.
import { SUMMARY_SYSTEM } from "../agent/aux.js";
import { resolveContextWindowOverride } from "../config/context-window-env.js";
import {
  CODEX_PROVIDER,
  getProviderProfile,
  resolveContextWindow,
  type ContextWindowResolution,
  type ContextWindowSource,
} from "../providers/index.js";
import type { ProviderProfile } from "../providers/index.js";
import { SUMMARY_LEAD_TEXT } from "../state/index.js";
import {
  CompactionFailedError,
  CompactionUnsupportedError,
  CompressionLockBusyError,
} from "./errors.js";
import type { ConversationRepository, ModelRequest } from "./types.js";

/** Trailing messages a compaction never touches (issue #252 AC: "mantendo
 * as N últimas mensagens intactas"). Turn-aligned (see
 * `turnAlignedTailCount` below), so this is a floor, not an exact count. */
export const DEFAULT_MIN_KEEP_MESSAGES = 8;

export const DEFAULT_LOCK_TTL_SECONDS = 30;
export const DEFAULT_LOCK_RETRIES = 3;
export const DEFAULT_LOCK_RETRY_DELAY_MS = 25;

/** Reserve beyond `maxTokens` before a request is allowed through
 * (reviewer note on PR #270: "superestimar a janela é a direção insegura").
 * `provider`/`default` sources never came from the provider's own catalog
 * response -- table #250 documents the Codex `1,050,000` floor as a value
 * read off a docs page, not measured -- so they get a bigger reserve. */
export const BASE_RESERVE_RATIO = 0.08;
export const CONSERVATIVE_RESERVE_RATIO = 0.15;

/**
 * How many of the trailing messages must survive a compaction untouched.
 * Walks backward from `messages.length - minKeep` looking for the nearest
 * `role: "user"` boundary -- every turn starts with a user message, so
 * landing there guarantees two things: (1) a `tool_calls` assistant message
 * is never separated from its `tool` results (they only ever sit strictly
 * between two user messages), and (2) the synthesized summary (inserted as
 * a `user`-lead + `assistant`-summary pair, see `buildSummaryMessages`) is
 * always followed by a `user` message, which keeps strict user/assistant
 * alternation for transports that require it (Anthropic). Pure.
 */
export function turnAlignedTailCount(
  messages: readonly Readonly<Record<string, unknown>>[],
  minKeep: number,
): number {
  const floor = Math.max(0, Math.min(messages.length, Math.trunc(minKeep)));
  for (let cut = messages.length - floor; cut > 0; cut -= 1) {
    if (messages[cut]?.role === "user") return messages.length - cut;
  }
  return messages.length;
}

/**
 * The largest estimate still allowed to reach the provider: the resolved
 * window, minus the reserved output budget (`maxTokens`), minus a margin
 * that widens when the window itself is an estimate rather than a
 * provider-reported measurement. Pure.
 */
export function compactionThreshold(input: {
  readonly window: number;
  readonly source: ContextWindowSource;
  readonly maxTokens: number;
}): number {
  const ratio =
    input.source === "provider" || input.source === "default"
      ? CONSERVATIVE_RESERVE_RATIO
      : BASE_RESERVE_RATIO;
  const margin = Math.ceil(input.window * ratio);
  return input.window - Math.max(0, input.maxTokens) - margin;
}

/** Minimal `ProviderProfile` for a provider name `getProviderProfile`
 * doesn't recognize -- `resolveContextWindow` then falls through to the
 * global `default` (200000) instead of throwing on a missing profile.
 * Defensive only: `runTurn`'s own provider is already known-good by the
 * time it reaches this module in every real caller. */
function unknownProviderProfile(name: string): ProviderProfile {
  return {
    name,
    apiMode: "chat_completions",
    aliases: [],
    displayName: name,
    description: "",
    signupUrl: "",
    envVars: [],
    baseUrl: "",
    modelsUrl: "",
    requiresApiKey: false,
    supportsVision: false,
    fallbackModels: [],
    defaultMaxTokens: 0,
    defaultAuxModel: "",
  };
}

/** `CODEX_PROVIDER` (the subscription route's profile, `commands/chat.ts`
 * sets `profile = CODEX_PROVIDER` directly) is deliberately never
 * registered in the provider registry `getProviderProfile` reads
 * (`src/providers/registry.ts:243-260`) -- it isn't selectable by name via
 * `--provider`. `runTurn` still passes `input.provider = profile.name` for
 * it ("openai-codex") like every other route, so this module has to know
 * about it by name to resolve its 1,050,000-token floor instead of silently
 * falling through to the unrelated 200000 global default. */
function knownProviderProfile(name: string): ProviderProfile {
  if (name === CODEX_PROVIDER.name) return CODEX_PROVIDER;
  return getProviderProfile(name) ?? unknownProviderProfile(name);
}

export function resolveTurnContextWindow(input: {
  readonly provider: string;
  readonly model: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): ContextWindowResolution {
  const profile = knownProviderProfile(input.provider);
  const override = resolveContextWindowOverride(input.environment);
  return resolveContextWindow({
    provider: input.provider,
    model: input.model,
    override,
    catalog: undefined,
    profile,
  });
}

/** The two messages a compaction inserts in place of the folded history:
 * a synthetic `user` lead (`SUMMARY_LEAD_TEXT`, single source of truth in
 * `src/state/session-repository.ts` -- `compactHistory` writes the exact
 * same pair this function describes) followed by the `assistant` summary
 * itself. The compacted history always opens on `role: "user"`, never
 * `"assistant"`: Anthropic's Messages API rejects a request whose first
 * message is not `role: "user"` (400) -- opening on the summary itself
 * would break every Anthropic-route turn the very first time a session
 * compacts. Never a bare `role: "system"` message either: the Anthropic
 * and Responses transports strip/merge a `role: "system"` message found
 * inside `messages` into the top-level system field
 * (`src/transports/anthropic-messages.ts:93`, `src/transports/responses.ts:37`)
 * -- that would fold the summary into the frozen system prompt, breaking
 * invariant 1 ("a compactação mexe no histórico, não no prompt"). This
 * `user`/`assistant` pair survives on every transport, opens on `user` (the
 * constraint above), and is always followed by another `user` message (see
 * `turnAlignedTailCount`) -- strict alternation end to end. */
export function buildSummaryMessages(
  summary: string,
): readonly [Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>] {
  return [
    Object.freeze({ role: "user", content: SUMMARY_LEAD_TEXT }),
    Object.freeze({ role: "assistant", content: summary, finish_reason: "stop" }),
  ];
}

function buildTranscript(messages: readonly Readonly<Record<string, unknown>>[]): string {
  return messages
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : "unknown";
      const content =
        typeof message.content === "string" && message.content.length > 0
          ? message.content
          : JSON.stringify(message.content ?? message.tool_calls ?? message);
      return `${role}: ${content}`;
    })
    .join("\n\n");
}

export interface CompactionAttemptInput {
  readonly repository: ConversationRepository;
  readonly summarize: (transcript: string) => Promise<string>;
  readonly sessionId: string;
  readonly holder: string;
  readonly now: number;
  readonly lockTtlSeconds: number;
  readonly lockRetries: number;
  readonly lockRetryDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly minKeepMessages: number;
}

export interface CompactionAttemptResult {
  readonly compacted: boolean;
  readonly summarizedCount: number;
  readonly keptCount: number;
  /** Fresh history after the attempt (unchanged content if `compacted` is
   * false, either because there was nothing left to fold or because another
   * process had already compacted it under the same lock). */
  readonly history: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Attempts exactly one compaction of `sessionId`'s persisted history:
 * acquire the compression lock (bounded retries -- never spins unbounded,
 * invariant 3), re-read the history under the lock (another process may
 * have already compacted it), fold everything but the trailing
 * turn-aligned tail into one summary via `summarize`, and rewrite it
 * atomically. Always releases the lock, even on failure.
 */
export async function attemptCompaction(
  input: CompactionAttemptInput,
): Promise<CompactionAttemptResult> {
  const repository = input.repository;
  if (
    repository.acquireCompressionLock === undefined ||
    repository.releaseCompressionLock === undefined ||
    repository.compactHistory === undefined
  ) {
    throw new CompactionUnsupportedError(input.sessionId);
  }

  let acquired = false;
  for (let attempt = 0; attempt < input.lockRetries; attempt += 1) {
    acquired = repository.acquireCompressionLock(
      input.sessionId,
      input.holder,
      input.now,
      input.lockTtlSeconds,
    );
    if (acquired) break;
    if (attempt < input.lockRetries - 1) await input.sleep(input.lockRetryDelayMs);
  }
  if (!acquired) throw new CompressionLockBusyError(input.sessionId);

  try {
    const freshHistory = repository.loadMessages(input.sessionId);
    const keepTailCount = turnAlignedTailCount(freshHistory, input.minKeepMessages);
    const summarizedCount = freshHistory.length - keepTailCount;
    if (summarizedCount <= 0) {
      return {
        compacted: false,
        summarizedCount: 0,
        keptCount: freshHistory.length,
        history: freshHistory,
      };
    }

    const transcript = buildTranscript(freshHistory.slice(0, summarizedCount));
    let summary: string;
    try {
      summary = await input.summarize(transcript);
    } catch (error) {
      throw new CompactionFailedError(input.sessionId, error);
    }

    const result = repository.compactHistory(input.sessionId, input.holder, input.now, {
      keepTailCount,
      summary,
    });
    const history = repository.loadMessages(input.sessionId);
    return {
      compacted: true,
      summarizedCount: result.summarizedCount,
      keptCount: result.keptCount,
      history,
    };
  } finally {
    repository.releaseCompressionLock(input.sessionId, input.holder);
  }
}

/** Builds the request a default (no-op-injected) summarizer sends to the
 * turn's own transport/model -- reuses `SUMMARY_SYSTEM`
 * (`src/agent/aux.ts`), the same prompt `AuxClient.summarize` uses, without
 * needing the raw provider client `AuxClient` itself requires (only
 * `commands/chat.ts` holds that today). */
export function buildSummaryRequest(input: {
  readonly transcript: string;
  readonly model: string;
  readonly signal: AbortSignal;
}): ModelRequest {
  return {
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: input.transcript }],
    model: input.model,
    temperature: null,
    effort: null,
    maxTokens: 1024,
    tools: [],
    signal: input.signal,
  };
}
