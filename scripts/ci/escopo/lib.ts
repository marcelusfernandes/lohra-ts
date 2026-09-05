// Regras puras do check `escopo` (issue #49): o diff da PR precisa caber
// nos globs que a `## Files` da issue declara, mais o que a PR autorizar
// explicitamente com `authorised:`. Nenhuma função aqui faz I/O — quem lê
// disco, git ou `gh` é sempre `run.ts`.
//
// STUB (test(red), issue #49): implementação real vem no commit seguinte.

/** Resultado de `checarEscopo`. */
export interface ResultadoEscopo {
  readonly ok: boolean;
  readonly fora: readonly string[];
}

export interface ArgsChecarEscopo {
  readonly files: readonly string[];
  readonly issueGlobs: readonly string[];
  readonly authorised?: readonly string[];
}

/** Conteúdo entre uma linha `heading` (prefixo, aceita sufixo como "(da issue #44)") e o próximo `## `. */
export function extrairSecao(_body: string, _heading: string): string | null {
  throw new Error("not implemented");
}

/** Globs de `## Files` da issue: só spans em crase dentro de bullets. */
export function globsDaIssue(_issueBody: string): string[] {
  throw new Error("not implemented");
}

/** Globs autorizados pelo orquestrador na PR: só linhas `authorised:`. */
export function globsAutorizados(_prBody: string): string[] {
  throw new Error("not implemented");
}

/** `ok:false` e `fora` lista os arquivos que não casam com nenhum glob (issue + authorised). */
export function checarEscopo(_args: ArgsChecarEscopo): ResultadoEscopo {
  throw new Error("not implemented");
}
