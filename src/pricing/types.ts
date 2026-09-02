export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}
export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion?: number;
  readonly cacheWritePerMillion?: number;
  readonly reasoningPerMillion?: number;
  readonly source?: string;
  readonly note?: string;
}
export interface CostEstimate {
  readonly usd: number;
  readonly grossUsd: number;
  readonly basis: "api_list_price" | "api_equivalent" | "local";
  readonly source?: string;
  readonly note?: string;
  readonly savedUsd: number;
}
