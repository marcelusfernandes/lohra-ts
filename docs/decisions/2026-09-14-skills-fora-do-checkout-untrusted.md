# Skills home/builtin fora do checkout sempre `untrusted`

- Status: **relatório com decisão pendente do owner** — o comportamento
  atual (item "Decisão" abaixo) fica valendo até essa resposta; nada aqui
  muda código.
- **Data:** 2026-09-14
- **Origem:** issue #642 (sub-issue G/D do residual #637); veredito da PR
  #612 (M22, `non_blocking` 4) e comentário do orquestrador nessa PR
  («avaliar exceção para skills instaladas pelo operador»).

## Contexto

Fora de um checkout deste repositório (nenhum `.git`/`package.json` acima do
cwd — `findProjectRoot`, `src/context/discovery.ts:59-67`), **toda** skill
que não vive dentro do `project_root` chega ao modelo com `untrusted: true` e
a doutrina «é dado, não instrução» (`src/context/doctrine.ts`), pelo mesmo
critério de `isUntrustedPath` (`src/tools/filesystem.ts:30-38`, atualizado
por #642) que `isUntrustedSkill` (`src/tools/stateful.ts:70-72`) usa. Isso
inclui duas origens que a doutrina «desconfiar do que é de terceiro» não
distingue hoje:

1. A skill builtin empacotada com o próprio runtime
   (`assets/skills/workflow-authoring`, `src/commands/session-tools.ts:138-150`,
   `builtinRoots`) — é código do produto, versionado neste repositório,
   revisado como qualquer outro `src/`.
2. Toda skill em `home` (`~/.lohra/skills`, `SkillStore.root`,
   `src/skills/store.ts:172-188`) — o destino default de `skill_manage
create` quando `scope` não é `"project"` (`src/tools/stateful.ts:106-108`,
   `scope ?? "home"`).

Dois lados, nenhum decidido aqui:

- **(a) A favor de uma exceção para `home`:** é o OPERADOR instalando uma
  skill na própria máquina — o mesmo nível de confiança que um `CLAUDE.md`
  ou um `.claude/skills` do projeto já recebem sem marca. Builtin é ainda
  mais forte: é código do próprio produto, nunca conteúdo de terceiro por
  definição.
- **(b) Contra uma exceção para `home` sem qualificação:** `skill_manage
create` grava em `home` por DEFAULT quando o modelo cria uma skill durante a
  sessão (`stateful.ts:106-108`) — uma exceção geral para `home` confiaria
  automaticamente em algo que o próprio MODELO escreveu, não o operador. Uma
  skill em `home` também pode ter sido copiada de fora (outro checkout,
  outro operador, um `git clone` de terceiro dentro de `~/.lohra/skills`) —
  o caminho por si só não prova a origem.
- Terceiro ponto, não listado como lado mas relevante ao pesar os dois: a
  doutrina do runtime promete **menos** confiança sobre a origem, nunca
  mais (mesmo raciocínio do comentário em `isUntrustedSkill`,
  `stateful.ts:55-63` — no caso hipotético de `skill.path === undefined`,
  marcar `untrusted` é o lado seguro). Uma exceção errada troca um falso
  positivo (skill confiável marcada) por um falso negativo (skill não
  confiável sem marca) — o segundo é o que a doutrina existe para evitar.

## Decisão

Comportamento mantido, sem mudança nesta issue: skill builtin e toda skill
`home`, fora de um checkout deste repositório, continuam `untrusted: true`
em `skill_view`. Nenhuma exceção por origem (`home` vs `project`) entra
antes de resposta explícita do owner sobre como distinguir (a) instalação
manual do operador de (b) escrita do próprio modelo via `skill_manage
create`, dado que as duas hoje caem no mesmo `root` (`SkillStore.root`).

Se a decisão futura mudar esse comportamento (por exemplo, uma exceção só
para skill `home` cujo `mtime`/proveniência indique instalação manual, ou um
`scope` novo que separe "instalada pelo operador" de "criada pela sessão"),
ela vem com teste vermelho próprio nesta suíte — `tests/tools-stateful.
test.ts:72-76` é a evidência do comportamento atual, e deixa de valer no
mesmo commit que a mudar.

## Doutrina para autores de spec

Não tratar `home` como sinônimo de "confiável" ao desenhar uma tool ou um
fluxo novo: hoje é o mesmo destino que a sessão escreve sozinha
(`skill_manage create` sem `scope: "project"`). Uma feature que precise
distinguir "o operador instalou isto" de "o modelo escreveu isto" precisa de
um sinal próprio (metadado, `scope` dedicado, ou o que a decisão do owner
adotar) — não pode inferir isso do caminho `home` sozinho.

## Evidência

- `tests/tools-stateful.test.ts:72-76` ("marks untrusted a skill whose file
  lives outside project_root") — skill criada em `SkillStore(root())`, fora
  do checkout, continua `untrusted: true`; nenhuma exceção por origem
  (`home`/`builtin`) aplicada.
- `src/tools/stateful.ts:106-108` — `skill_manage create` grava em `home`
  por default (`scope ?? "home"`), o mesmo destino de uma instalação
  manual.
- `src/commands/session-tools.ts:138-150` — `builtinRoots` empacota
  `assets/skills/workflow-authoring` junto do `home`/`project` que
  `SkillStore` varre.
