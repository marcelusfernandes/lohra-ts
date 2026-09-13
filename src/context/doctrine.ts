// Issue #579 (épico #575, P3): stub vermelho — `tests/context-doctrine.test.ts`
// prova o contrato antes da implementação real existir. Toda exportação
// lança em runtime (nunca erro de compilação) para o vermelho do
// `controle-negativo` ser de teste, não de `tsc`.

export const DOCTRINE_CORE = "";
export const DOCTRINE_EXTENDED = "";

export type DoctrineTier = "core" | "extended";

export function doctrineText(_tier: DoctrineTier): string {
  throw new Error("not implemented: doctrineText");
}

export interface ResolveDoctrineTierInput {
  readonly providerName: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export function resolveDoctrineTier(_input: ResolveDoctrineTierInput): DoctrineTier {
  throw new Error("not implemented: resolveDoctrineTier");
}
