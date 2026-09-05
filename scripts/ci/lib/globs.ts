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

function escaparRegExp(literal: string): string {
  return literal.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Traduz um glob (`**`, `*`, literal) para uma RegExp ancorada (`^...$`). */
export function globParaRegex(glob: string): RegExp {
  const padrao = glob
    .split(/(\*\*|\*)/)
    .map((pedaco) => {
      if (pedaco === "**") return ".*";
      if (pedaco === "*") return "[^/]*";
      return escaparRegExp(pedaco);
    })
    .join("");
  return new RegExp(`^${padrao}$`);
}

/** `true` quando `caminho` casa com `glob` (`**`, `*`, literal). */
export function casa(glob: string, caminho: string): boolean {
  return globParaRegex(glob).test(caminho);
}
