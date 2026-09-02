import type { ChatKwargs, NormalizedResponse, ProviderTransport } from "../transports/index.js";

export const SUMMARY_SYSTEM =
  "You are compacting a long conversation to fit the context window. Summarize " +
  "the transcript below into a concise but complete reference. Under these " +
  "headings, keep only what is still relevant: Active Task; Goal; Completed " +
  "Actions (results, not narration); Active State (files/vars/decisions in " +
  "play); Blocked/Open; Key Decisions (and why); Pending User Asks; Remaining " +
  "Work. Be factual and terse. Never invent details.";

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
