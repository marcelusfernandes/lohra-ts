export type CatalogSource = "live" | "config" | "skipped" | "error";

export interface ProviderModelsValue {
  readonly provider: string;
  readonly source: CatalogSource;
  readonly total: number;
  readonly models: readonly string[];
  readonly detail?: string;
}

export class ProviderModels implements ProviderModelsValue {
  readonly provider: string;
  readonly source: CatalogSource;
  readonly total: number;
  readonly models: readonly string[];
  readonly detail: string;
  constructor(
    provider: string,
    source: CatalogSource,
    models: readonly string[] = [],
    total = models.length,
    detail = "",
  ) {
    this.provider = provider;
    this.source = source;
    this.models = Object.freeze([...models]);
    this.total = total;
    this.detail = detail;
  }
  toJSON(): ProviderModelsValue {
    return {
      provider: this.provider,
      source: this.source,
      total: this.total,
      models: this.models,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export class Catalog {
  readonly entries: readonly ProviderModels[];
  constructor(entries: readonly ProviderModels[]) {
    this.entries = Object.freeze([...entries]);
  }
  get(provider: string): ProviderModels | undefined {
    return this.entries.find((entry) => entry.provider === provider);
  }
  toJSON(): { readonly providers: readonly ProviderModelsValue[] } {
    return { providers: this.entries.map((entry) => entry.toJSON()) };
  }
}
