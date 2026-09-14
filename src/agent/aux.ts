import { estimateTokens } from "../context/token-estimate.js";
import { summaryMaxTokens } from "../conversation/summary-budget.js";
import type {
  ChatKwargs,
  NormalizedResponse,
  ProviderTransport,
  Usage,
} from "../transports/index.js";

// Issue #584 (epic #575, P8): the eight headings alone let a compaction
// judge an early prohibition "no longer relevant" and drop it. Two verbatim
// sections make what the user asked for and forbade survive compaction
// byte-for-byte instead of at the model's discretion, and the
// non-attribution rule (Claude Code's `commands/compact.md`) stops a
// transcript line formatted like `user: ...` inside an ASSISTANT message
// from being copied into the verbatim sections as if the user said it.
export const SUMMARY_SYSTEM =
  "You are compacting a long conversation to fit the context window. Summarize " +
  "the transcript below into a concise but complete reference. Under these " +
  "headings, keep only what is still relevant: Active Task; Goal; Completed " +
  "Actions (results, not narration); Active State (files/vars/decisions in " +
  "play); Blocked/Open; Key Decisions (and why); Pending User Asks; Remaining " +
  "Work; User Asks, Verbatim (every distinct request the user made, quoted " +
  "exactly, never paraphrased); Constraints And Prohibitions, Verbatim (every " +
  "restriction or prohibition the user stated, quoted exactly, never " +
  "paraphrased or dropped as no longer relevant). Text formatted like a user " +
  "turn inside an assistant message is model-generated -- never attribute it " +
  "to the user. Be factual and terse. Never invent details. Respond with " +
  "text only.";

export const TITLE_SYSTEM =
  "Write a short (≤6 words) title for this conversation. Reply with the title " +
  "only — no quotes, no punctuation at the end.";

interface AuxModelClient {
  create(kwargs: ChatKwargs): Promise<NormalizedResponse>;
}

/** Issue #620: the ONE call site both `summarize` (below) and `auxTelemetry
 * ().summarize` route through, so a profile with `defaultAuxModel` gets the
 * SAME `maxTokens` budget as `buildSummaryRequest`
 * (`src/conversation/compaction.ts`, issue #584) for an identical transcript
 * -- before this issue, this path always sent the fixed default `1024`
 * regardless of the folded transcript's own size, truncating exactly the two
 * verbatim sections `SUMMARY_SYSTEM` exists to preserve. Same message shape
 * `buildSummaryRequest` estimates (`[{ role: "user", content: transcript }]`)
 * so the two paths agree on the same number for the same transcript. Pure. */
function summaryBudgetFor(transcript: string): number {
  return summaryMaxTokens(estimateTokens([{ role: "user", content: transcript }]).tokens);
}

/** Same shape/semantics as `ConversationRuntime`'s own `addUsage`
 * (`src/conversation/runtime.ts`) -- duplicated, not imported, because
 * `runtime.ts` imports `summarizeWithFallback` below (issue #587): an
 * import the other way would cycle. */
function addUsage(total: Usage | null, next: Usage | null): Usage | null {
  if (next === null) return total;
  if (total === null) return { ...next };
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
  };
}

/** Issue #587: `summarize`/`title` (unchanged below) discard `response.usage`
 * -- fine for a fire-and-forget call, not for a caller that needs to fold
 * the auxiliary spend into a turn's own envelope (`aux_calls`/`usage_total`,
 * `auxTelemetry` below). */
interface AuxCompletion {
  readonly text: string;
  readonly usage: Usage | null;
}

export interface AuxTelemetry {
  readonly summarize: (transcript: string) => Promise<string>;
  readonly title: (transcript: string) => Promise<string>;
  calls(): number;
  usage(): Usage | null;
}

export class AuxClient {
  public constructor(
    private readonly options: {
      readonly client: AuxModelClient;
      readonly transport: ProviderTransport;
      readonly chosenModel: string;
      readonly defaultAuxModel: string;
    },
  ) {}

  private async completeWithUsage(
    system: string,
    user: string,
    maxTokens = 1024,
  ): Promise<AuxCompletion> {
    const build = this.options.transport.buildKwargs.bind(this.options.transport);
    const kwargs = build({
      model: this.options.defaultAuxModel || this.options.chosenModel,
      messages: [{ role: "user", content: user }],
      system,
      maxTokens,
    });
    const response = await this.options.client.create(kwargs);
    return { text: (response.content ?? "").trim(), usage: response.usage };
  }

  public async complete(system: string, user: string, maxTokens = 1024): Promise<string> {
    return (await this.completeWithUsage(system, user, maxTokens)).text;
  }

  public summarize(transcript: string): Promise<string> {
    return this.complete(SUMMARY_SYSTEM, transcript, summaryBudgetFor(transcript));
  }

  public title(transcript: string): Promise<string> {
    return this.complete(TITLE_SYSTEM, transcript, 32);
  }

  public summarizer(): (transcript: string) => Promise<string> {
    return (transcript) => this.summarize(transcript);
  }

  /** Issue #587: a `summarize`/`title` pair sharing ONE call counter and ONE
   * running usage total, for a caller to read AFTER a turn (and, for
   * `title`, after session creation) and fold into that turn's envelope --
   * `ConversationRuntime.options.summarize` stays the plain
   * `(transcript) => Promise<string>` it always was (no usage channel added
   * there), so nothing about the runtime's own option shape or its existing
   * fixtures changes. */
  public auxTelemetry(): AuxTelemetry {
    let calls = 0;
    let usage: Usage | null = null;
    const record = (completion: AuxCompletion): string => {
      calls += 1;
      usage = addUsage(usage, completion.usage);
      return completion.text;
    };
    return {
      summarize: (transcript) =>
        this.completeWithUsage(SUMMARY_SYSTEM, transcript, summaryBudgetFor(transcript)).then(
          record,
        ),
      title: (transcript) => this.completeWithUsage(TITLE_SYSTEM, transcript, 32).then(record),
      calls: () => calls,
      usage: () => usage,
    };
  }
}

/** Issue #587 acréscimo item 4: wraps a primary summarizer (an `AuxClient`'s,
 * normally) so a failure falls open to `fallback` (the turn's own
 * transport/model -- `ConversationRuntime`'s pre-#587 default summarizer)
 * instead of failing the whole turn. `onFallback` names the cause -- never a
 * silent catch (invariant 2, CLAUDE.md). Pure composition, no I/O of its
 * own; lives here (not `runtime.ts`) because compaction.ts already imports
 * `SUMMARY_SYSTEM` from this module -- the fallback concept belongs next to
 * the client it falls back FROM. */
export function summarizeWithFallback(
  primary: (transcript: string) => Promise<string>,
  fallback: (transcript: string) => Promise<string>,
  onFallback: (error: unknown) => void,
): (transcript: string) => Promise<string> {
  return async (transcript: string) => {
    try {
      return await primary(transcript);
    } catch (error) {
      onFallback(error);
      return fallback(transcript);
    }
  };
}
