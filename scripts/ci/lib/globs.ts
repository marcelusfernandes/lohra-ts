// Matcher de glob mínimo para o check `escopo` (issue #49). Sem dependência
// nova: os globs do repo são simples (`dir/**`, `dir/*.ext`, um arquivo
// exato), então um tradutor para RegExp resolve — `minimatch`/`micromatch`
// seriam uma dependência que o glob de `Files` desta issue
// (`scripts/ci/lib/**`) não autoriza.
//
// Tokens suportados: `**/` (zero ou mais segmentos de diretório, inclusive
// nenhum — issue #62: o cabeçalho já prometia isso, mas a implementação
// original tratava `**` sempre como ".*" plano, então `**/*.md` exigia uma
// barra de verdade e não casava `README.md` na raiz), `**` sem barra
// (qualquer coisa, inclusive atravessando `/`), `*` (qualquer coisa exceto
// `/`), `?` (um caractere literal — issue #62: não escapado, virava
// quantificador de regex e tornava o caractere anterior opcional), o resto
// é literal. Paths são comparados como POSIX-relativos (barra normal) — é o
// que `git diff --name-only` sempre imprime.

function escaparRegExp(literal: string): string {
  return literal.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
}

/** Traduz um glob (`**` seguido de barra, `**` sozinho, `*`, `?`, literal)
 * para uma RegExp ancorada (`^...$`). O token `**` seguido de barra — só
 * nesse caso — vira um grupo opcional que também casa zero segmentos; `**`
 * sem barra continua ".*" (mesmo comportamento de antes, preservado pelos
 * testes existentes). */
export function globParaRegex(glob: string): RegExp {
  const padrao = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map((pedaco) => {
      if (pedaco === "**/") return "(?:.*/)?";
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
