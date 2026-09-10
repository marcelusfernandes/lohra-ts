export type CatalogSource = "live" | "config" | "skipped" | "error";

// `windows` é opcional aqui (não no runtime — `ProviderModels.windows` é
// sempre um objeto, nunca `undefined`) pelo mesmo motivo de `detail`:
// `toJSON()` omite a chave quando está vazia, para não inflar o `--json`
// público de todo provedor sem janela nenhuma (skipped/config/erro) com um
// `"windows":{}` redundante — bytes que `tests/providers.test.ts` e
// `tests/auth-cli.test.ts` (fora do escopo desta issue) já pinam.
export interface ProviderModelsValue {
  readonly provider: string;
  readonly source: CatalogSource;
  readonly total: number;
  readonly models: readonly string[];
  readonly windows?: Readonly<Record<string, number | null>>;
  readonly detail?: string;
}

export class ProviderModels implements ProviderModelsValue {
  readonly provider: string;
  readonly source: CatalogSource;
  readonly total: number;
  readonly models: readonly string[];
  readonly windows: Readonly<Record<string, number | null>>;
  readonly detail: string;
  constructor(
    provider: string,
    source: CatalogSource,
    models: readonly string[] = [],
    total = models.length,
    detail = "",
    windows: Readonly<Record<string, number | null>> = {},
  ) {
    this.provider = provider;
    this.source = source;
    this.models = Object.freeze([...models]);
    this.total = total;
    this.detail = detail;
    this.windows = Object.freeze({ ...windows });
  }
  toJSON(): ProviderModelsValue {
    return {
      provider: this.provider,
      source: this.source,
      total: this.total,
      models: this.models,
      ...(Object.keys(this.windows).length > 0 ? { windows: this.windows } : {}),
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
