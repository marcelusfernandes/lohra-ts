// Matcher de glob mínimo para o check `escopo` (issue #49). Sem dependência
// nova: os globs do repo são simples (`dir/**`, `dir/*.ext`, um arquivo
// exato), então um tradutor para RegExp resolve — `minimatch`/`micromatch`
// seriam uma dependência que o glob de `Files` desta issue
// (`scripts/ci/lib/**`) não autoriza.
//
// Tokens suportados: `**` (qualquer número de segmentos de path, inclusive
// zero), `*` (qualquer coisa exceto `/`), o resto é literal. Paths são
// comparados como POSIX-relativos (barra normal) — é o que `git diff
// --name-only` sempre imprime.
//
// STUB (test(red), issue #49): implementação real vem no commit seguinte.

/** Traduz um glob (`**`, `*`, literal) para uma RegExp ancorada (`^...$`). */
export function globParaRegex(_glob: string): RegExp {
  throw new Error("not implemented");
}

/** `true` quando `caminho` casa com `glob` (`**`, `*`, literal). */
export function casa(_glob: string, _caminho: string): boolean {
  throw new Error("not implemented");
}
