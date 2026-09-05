// Stub temporário (commit `test(red)`) — implementação em commit(s) seguintes.
export interface Violacao {
  readonly id: string;
  readonly arquivo: string;
  readonly descricao: string;
}

export interface Regra {
  readonly id: string;
  readonly descreve: string;
  avalia(arquivo: string, conteudo: string | null): Violacao | null;
}

export const regras: readonly Regra[] = [];

export function rodarContratos(
  files: readonly string[],
  lerConteudo: (arquivo: string) => string | null,
): readonly Violacao[] {
  void files;
  void lerConteudo;
  throw new Error("not implemented");
}
