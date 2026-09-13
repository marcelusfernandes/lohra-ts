import type { ChatKwargs, NormalizedResponse, ProviderTransport } from "../transports/index.js";

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

export class AuxClient {
  public constructor(
    private readonly options: {
      readonly client: AuxModelClient;
      readonly transport: ProviderTransport;
      readonly chosenModel: string;
      readonly defaultAuxModel: string;
    },
  ) {}

  public async complete(system: string, user: string, maxTokens = 1024): Promise<string> {
    const build = this.options.transport.buildKwargs.bind(this.options.transport);
    const kwargs = build({
      model: this.options.defaultAuxModel || this.options.chosenModel,
      messages: [{ role: "user", content: user }],
      system,
      maxTokens,
    });
    const response = await this.options.client.create(kwargs);
    return (response.content ?? "").trim();
  }

  public summarize(transcript: string): Promise<string> {
    return this.complete(SUMMARY_SYSTEM, transcript);
  }

  public title(transcript: string): Promise<string> {
    return this.complete(TITLE_SYSTEM, transcript, 32);
  }

  public summarizer(): (transcript: string) => Promise<string> {
    return (transcript) => this.summarize(transcript);
  }
}
