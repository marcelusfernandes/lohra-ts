# Skills nos harnesses: instalar no `init`, atualizar no `update`

- Status: **relatório de exploração** — decisão do owner pendente. Nada aqui é
  normativo até o owner responder.
- Data: 2026-09-10
- Issue: [#255](https://github.com/marcelusfernandes/lohra-ts/issues/255),
  milestone "Skills nos harnesses: instalar no init, atualizar no update"
- Baseline: `1a4773b8` (`main` de 2026-09-10)
- Escopo: só investigação. Nenhuma linha de `src/` mudou nesta PR.

---

## Recomendação ao owner, em linguagem simples

**Sim, vale — mas duas coisas vêm antes, e o desenho fica mais simples do que
você imaginou.** Antes: hoje o `lohra init` está estragando a máquina de quem diz
"sim". A skill que o lohra-ts exporta (`assets/skills/use-lohra/SKILL.md`) é a do
Lohra **Python** — todo comando dentro dela é `lohra chat`, nenhum é `lohra-ts` —
e essa cópia está **53 linhas atrás** da que já está instalada em
`~/.claude/skills/use-lohra`. Como a escrita é cega (`src/skills/export.ts:19-25`
sobrescreve sem olhar o destino), quem responde "sim" instala a skill do runtime
errado **e** rebaixa a skill boa que já tinha. A skill que você validou,
`use-lohra-ts`, **não existe em lugar nenhum do repositório**.

**Mais simples: os quatro harnesses não são quatro destinos, são dois.** A
documentação oficial de Codex, OpenCode e Pi diz que os três leem o mesmo
diretório compartilhado `~/.agents/skills/`. Só o Claude Code não lê (ele lê
`~/.claude/skills/`) — e o Claude Code documenta que uma entrada de skill pode
ser um **symlink**. Então a instalação inteira é: uma cópia real em
`~/.agents/skills/use-lohra-ts/`, e um symlink `~/.claude/skills/use-lohra-ts →`
essa cópia. Duas escritas cobrem os quatro harnesses, e uma atualização atualiza
todos de uma vez.

**Isso muda o pedido do multi-select.** "Escolher em quais harnesses instalar"
não é oferecível como quatro caixas independentes: instalar "só no Codex"
inevitavelmente expõe a skill ao OpenCode e ao Pi, porque é a mesma pasta. A
escolha honesta tem dois itens, não quatro. O `Prompter` de hoje
(`src/onboarding/wizard.ts:65-107`) já dá conta disso com uma lista numerada —
**não precisa de TUI Ink no `init`**. E o `update` deve se apoiar num
**manifesto** `~/.lohra/skills-install.json`, não num carimbo dentro do
frontmatter.

---

## O bloqueio que apareceu antes das hipóteses

Não estava previsto na issue e reordena tudo o que vem depois.

| fato                                                             | evidência                                                                                                                                                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A única skill exportável do lohra-ts é a do runtime **Python**   | `assets/skills/use-lohra/SKILL.md`, linhas 22, 28, 43, 48, 51, 87 — todas as invocações são `lohra chat --profile "lohra-<project>"`; `grep -c 'lohra-ts'` no arquivo devolve 0                          |
| A cópia do repositório está desatualizada em relação à instalada | `diff assets/skills/use-lohra/SKILL.md ~/.claude/skills/use-lohra/SKILL.md` → 53 linhas só do lado instalado (`--provider` de uma volta só, `--token-budget-cap`, `usage_total`/`cost`, `lohra notices`) |
| A escrita é cega                                                 | `src/skills/export.ts:19-25` — `writeFileSync` direto, sem ler o destino                                                                                                                                 |
| O `init` chama exatamente isso                                   | `src/onboarding/wizard.ts:279-298` — um único `confirm`, e `writeExportable("use-lohra", <harness>/skills)` para **todos** os harnesses presentes                                                        |
| `use-lohra-ts` não existe no repositório                         | `git grep -l 'use-lohra-ts'` → vazio; `git ls-files assets/skills` → só `use-lohra` e `workflow-authoring`                                                                                               |
| O comando que a skill validada invoca não é entregue pelo pacote | `package.json:12-14` → `"bin": { "lohra": "dist/cli.js" }`; `cat ~/.local/bin/lohra-ts` → wrapper escrito à mão, `exec env LOHRA_PROFILE=ts node .../dist/cli.js`                                        |

Consequência: **qualquer automação de instalação amplifica esse dano em vez de
corrigi-lo.** Corrigir a identidade da skill é pré-requisito, não polimento.

---

## H2 — Conjunto e localização dos harnesses

**Veredito: confirmada, com uma descoberta que reduz o problema.** Os quatro
harnesses têm conceito de skill compatível (todos seguem, com desvios, a spec
aberta Agent Skills). Nenhum sai da lista. Mas **três dos quatro leem um
diretório compartilhado**, então "quatro harnesses" não significa "quatro
destinos de escrita".

### Matriz

|                                   | Claude Code                                                                                    | Codex CLI                                                                   | OpenCode                                                      | Pi                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| executável                        | `claude`                                                                                       | `codex`                                                                     | `opencode`                                                    | `pi`                                                                |
| dir de config                     | `~/.claude/` (`$CLAUDE_CONFIG_DIR`)                                                            | `~/.codex/` (`$CODEX_HOME`)                                                 | `~/.config/opencode/` (`$OPENCODE_CONFIG_DIR`)                | `~/.pi/agent/`                                                      |
| arquivo de config                 | `settings.json`                                                                                | `config.toml`                                                               | `opencode.json[c]`                                            | `settings.json`                                                     |
| **skills de usuário**             | `~/.claude/skills/<n>/SKILL.md`                                                                | `$HOME/.agents/skills/<n>/` (ver conflito abaixo)                           | `~/.config/opencode/skills/<n>/`                              | `~/.pi/agent/skills/<n>/`                                           |
| **outros dirs de usuário lidos**  | —                                                                                              | —                                                                           | `~/.claude/skills`, `~/.agents/skills`                        | `~/.agents/skills`                                                  |
| skills de projeto                 | `.claude/skills/<n>/`                                                                          | `.agents/skills/` (do CWD até a raiz do repo)                               | `.opencode/skills/<n>/`, `.claude/skills/`, `.agents/skills/` | `.pi/skills/<n>/`, `.agents/skills/` (com confirmação de confiança) |
| formato                           | `SKILL.md` + frontmatter YAML                                                                  | idem                                                                        | idem                                                          | idem                                                                |
| `name` obrigatório                | não (default = nome do diretório)                                                              | sim                                                                         | sim (≤64, **igual ao diretório**)                             | sim (≤64, **pode diferir** do diretório)                            |
| limite de `description`           | 1536 (com `when_to_use`)                                                                       | não documentado                                                             | 1024                                                          | 1024                                                                |
| chave desconhecida no frontmatter | tolerada; `metadata` é campo próprio                                                           | não documentado                                                             | **ignorada**                                                  | tolerada; `metadata` é campo próprio                                |
| distribuição nativa               | plugins + `.claude-plugin/marketplace.json`                                                    | plugins + `.agents/plugins/marketplace.json`; `$skill-installer` (só local) | **nenhuma documentada**                                       | `pi install npm:…` / `git:…` (pacotes Pi)                           |
| symlink                           | **documentado: sim** (locais não-plugin; carrega uma vez só se vários apontarem ao mesmo alvo) | **documentado: sim**                                                        | não documentado (11 symlinks em uso nesta máquina)            | não documentado                                                     |
| detecção proposta                 | `claude` no PATH ou `~/.claude/` existe                                                        | `codex` no PATH ou `$CODEX_HOME`/`~/.codex/` existe                         | `opencode` no PATH ou `~/.config/opencode/` existe            | `pi` no PATH ou `~/.pi/agent/` existe                               |

Fontes: <https://code.claude.com/docs/en/skills>,
<https://code.claude.com/docs/en/plugins>,
<https://code.claude.com/docs/en/plugin-marketplaces>,
<https://code.claude.com/docs/en/settings>,
<https://learn.chatgpt.com/docs/build-skills>,
<https://learn.chatgpt.com/docs/config-file/config-reference>,
<https://developers.openai.com/plugins/build/plugins>,
<https://opencode.ai/docs/skills/>, <https://opencode.ai/docs/config/>,
<https://opencode.ai/docs/cli/>, <https://pi.dev/docs/latest/skills>,
<https://github.com/earendil-works/pi> (o `pi` é o harness da earendil-works,
ex-`badlogic/pi-mono`), <https://agentskills.io/specification>.

### A spec aberta (Agent Skills) e o que ela permite

`name` (1–64, `^[a-z0-9]+(-[a-z0-9]+)*$`, igual ao diretório) e `description`
(1–1024) são obrigatórios; `license`, `compatibility` (≤500), `metadata` (mapa
string→string) e `allowed-tools` (experimental) são opcionais. **Não existe campo
`version` de topo** — o próprio exemplo da spec põe a versão dentro de
`metadata`. Fonte: <https://agentskills.io/specification>.

Consequência para H3: se houver carimbo, ele vai em
`metadata.lohra_version` / `metadata.lohra_sha256`, nunca como chave de topo.

### O conflito do Codex, declarado

A documentação atual da OpenAI **não lista `~/.codex/skills` em lugar nenhum**: a
tabela de escopos dá `$HOME/.agents/skills` como o caminho de usuário
(<https://learn.chatgpt.com/docs/build-skills.md>). Mas o Codex instalado nesta
máquina tem `~/.codex/skills/` com skills reais, um diretório `.system/` de
builtins da OpenAI, e uma dessas builtins — `skill-installer` — cuja própria
descrição diz "Install Codex skills into `$CODEX_HOME/skills`". Ou seja: **o
binário e a documentação discordam**, provavelmente por defasagem de versão.

Decisão prática: escrever em `$HOME/.agents/skills` (documentado, e de quebra
cobre OpenCode e Pi) e apenas **reportar** `~/.codex/skills` se existir. O
`update` **nunca** escreve em `~/.codex/skills/.system/` — é território da OpenAI.

### Consequência de desenho: dois destinos, não quatro

- `~/.agents/skills/use-lohra-ts/SKILL.md` — cópia real. Cobre **Codex**
  (caminho de usuário documentado), **OpenCode** (dir de fallback documentado) e
  **Pi** (dir global documentado).
- `~/.claude/skills/use-lohra-ts` — **symlink** para a cópia acima. O Claude Code
  documenta symlink de diretório de skill e diz que carrega a skill uma vez só
  quando vários locais apontam para o mesmo alvo — o que também neutraliza a
  duplicata que apareceria no OpenCode (que lê `~/.claude/skills` _e_
  `~/.agents/skills`). Em Windows, onde symlink de diretório exige privilégio,
  o fallback é cópia.

---

## H1 — Escolha por harness no `init`

**Veredito: confirmada quanto ao mecanismo (Ink não é necessário), reformulada
quanto à granularidade (a escolha tem dois itens, não quatro).**

### Ink não é necessário — a cláusula de falsificação não dispara

- O `Prompter` (`src/onboarding/wizard.ts:65-107`) tem três métodos — `ask`,
  `confirm`, `note` — e lê pelo `reader: () => string` injetado em
  `src/cli.ts:466`. É **orientado a linha**: sem raw mode, sem leitura de tecla,
  logo checkbox navegável por setas está fora com o que existe hoje.
- Mas multi-select não exige setas. Um `ask("destinos (ex.: 1,2 — Enter aceita o
sugerido)", "1,2")` sobre uma lista numerada impressa por `note()` entrega a
  escolha **sem dependência nova**, sem raw mode e sem quebrar o contrato de
  teste (o reader é injetado, continua testável por string).
- Trazer Ink para o `init` seria contramão da meta de produto: a TUI Ink é
  _renderer do protocolo de eventos_ (CLAUDE.md, "Meta de produto"), e o `init`
  roda antes de existir sessão ou evento.

### A granularidade honesta é o destino, não o harness

Oferecer quatro caixas independentes seria mentira de interface: marcar "Codex" e
desmarcar "OpenCode" não é implementável, porque os dois leem
`~/.agents/skills`. A lista deve nomear o que de fato se escreve, dizendo quem
enxerga cada item:

```
onde instalar a skill `use-lohra-ts`?
  1. ~/.agents/skills   — lido por Codex, OpenCode e Pi   [detectados: codex, opencode]
  2. ~/.claude/skills   — Claude Code (symlink para 1)    [detectado]
destinos [1,2]:
```

Os detectados entram no default; os não detectados aparecem marcados
`(não detectado)` e ficam fora do default, mas podem ser escolhidos à mão.

### Caminho não interativo

Duas coisas faltam hoje:

- `INIT_SPEC = spec(COMMON_FLAGS)` (`src/cli/arg-spec.ts:47`) — sem `--harness` e
  sem `--no-harness`.
- `runInit` retorna em `src/onboarding/wizard.ts:315-318` **antes** de
  `runConfigure` quando `--no-input` ou sem TTY. Hoje `--no-input` não exporta
  nada; um `--harness a,b` precisa de um ramo **antes** desse retorno, não dentro
  do `runConfigure`.

Proposta: `--no-input` continua não instalando nada por default (seguro em CI);
`--harness claude,agents` instala nesses destinos; `--no-harness` é o jeito
explícito de um script dizer "não instale"; nome desconhecido é erro com a lista,
nunca instalação silenciosa parcial (fail-closed).

---

## H3 — O `update` atualiza o que o Lohra instalou, e só isso

**Veredito: reformulada.** O mecanismo A (manifesto) vence; a cláusula de
falsificação precisa ser corrigida, não aplicada.

### A cláusula de falsificação está mal posta

Nenhum dos dois candidatos detecta "usuário editou" sem ler o arquivo: um hash é
função do conteúdo. Ler um `SKILL.md` de poucos KB por skill instalada é
irrelevante em custo — o `update` já roda `git pull` + `npm install`
(`src/commands/update.ts:24-46`). A pergunta útil não é "sem ler", é **quem
guarda a expectativa contra a qual o conteúdo lido é comparado**. É nisso que A e
B diferem.

### A × B

| critério                               | A — `~/.lohra/skills-install.json`                                                                                             | B — carimbo em `metadata` do frontmatter                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| onde vive a expectativa                | fora do arquivo instalado, sob controle do Lohra                                                                               | dentro do arquivo, sob controle de quem editar                                                                                                              |
| depende do harness aceitar chave extra | **não**                                                                                                                        | sim — viável hoje (`metadata` é campo da spec; Claude Code, OpenCode e Pi documentam; Codex não documenta nem proíbe), mas é aposta em contrato de terceiro |
| detecta "usuário apagou a skill"       | sim (caminho registrado, `existsSync` falso)                                                                                   | não — não há onde procurar sem já saber o caminho                                                                                                           |
| detecta "usuário moveu a skill"        | sim (some do caminho registrado)                                                                                               | só varrendo todo diretório de skill conhecido, o que é varredura, não carimbo                                                                               |
| detecta "usuário editou"               | sim — `sha256(disco)` ≠ hash registrado                                                                                        | sim — mas o carimbo é editável junto com o corpo                                                                                                            |
| dois checkouts do Lohra                | entrada com campo `source` = caminho do checkout; o segundo vê que não foi ele que instalou e **avisa em vez de sobrescrever** | invisível: o carimbo diz a versão, não qual checkout                                                                                                        |
| harness desinstalado                   | entrada órfã detectável e reportável                                                                                           | nada a reportar                                                                                                                                             |
| sobrevive à perda do próprio registro  | não (manifesto apagado ⇒ o Lohra "esquece")                                                                                    | sim (o arquivo se descreve)                                                                                                                                 |
| precedente no código                   | `~/.lohra/workflow_policy.json` e `~/.lohra/context-windows.json` já são registros JSON na base                                | `src/skills/store.ts:53-70` já renderiza frontmatter — mas com `version:`/`platforms:` **de topo**, que estão fora da spec                                  |

**Escolha: A como fonte da verdade; B opcional, e só sob `metadata`.** A não
depende de contrato de terceiro nenhum, e é o único dos dois que enxerga skill
apagada, movida ou instalada por outro checkout — que são exatamente os casos que
a issue pede para comparar.

O manifesto mora em **`~/.lohra`** (a base), nunca no home de perfil:
`~/.lohra/profiles/` tem mais de dez perfis nesta máquina, e um manifesto por
perfil fragmentaria o registro de uma instalação que é única por usuário.

### Forma do manifesto

```json
{
  "version": 1,
  "entries": [
    {
      "target": "agents",
      "skill": "use-lohra-ts",
      "path": "/Users/<user>/.agents/skills/use-lohra-ts/SKILL.md",
      "kind": "copy",
      "sha256": "<hash do que o Lohra escreveu>",
      "lohra_version": "0.0.11",
      "source": "/Users/<user>/Desktop/playground-ai/lohra-ts",
      "installed_at": "2026-09-10T12:00:00Z"
    },
    {
      "target": "claude",
      "skill": "use-lohra-ts",
      "path": "/Users/<user>/.claude/skills/use-lohra-ts",
      "kind": "symlink",
      "link_to": "/Users/<user>/.agents/skills/use-lohra-ts",
      "lohra_version": "0.0.11",
      "source": "/Users/<user>/Desktop/playground-ai/lohra-ts",
      "installed_at": "2026-09-10T12:00:00Z"
    }
  ]
}
```

### Regra de decisão do `update` (fail-closed)

Para cada entrada, com `d` = o que está no disco:

| situação                                                               | ação                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `d` ausente                                                            | não recria em silêncio: reporta "removida por você" e imprime o comando de instalar; a entrada só sai do manifesto com `--prune` |
| `kind: copy`, `sha256(d)` igual ao registrado, conteúdo novo diferente | **substitui** e atualiza a entrada                                                                                               |
| `kind: copy`, `sha256(d)` igual ao registrado, conteúdo igual          | nada a fazer                                                                                                                     |
| `kind: copy`, `sha256(d)` diferente do registrado                      | **não toca**. Avisa: "você editou `<path>`; `--force` sobrescreve"                                                               |
| `kind: symlink`, alvo ainda é o registrado                             | nada a fazer (a cópia canônica já foi atualizada)                                                                                |
| `kind: symlink`, virou arquivo comum ou aponta para outro lugar        | **não toca**; reporta                                                                                                            |
| `source` diferente do checkout atual                                   | avisa e não toca (outro checkout é o dono)                                                                                       |
| diretório do destino sumiu                                             | reporta entrada órfã; não recria diretório de harness desinstalado                                                               |

O `update` **nunca apaga** uma skill: `update` que apaga arquivo do usuário é a
falha que a issue quer evitar. A colisão `use-lohra` × `use-lohra-ts` (H5) se
resolve por **aviso**, não por remoção.

---

## H4 — `lohra skill export` continua existindo

**Veredito: confirmada, com a própria cláusula de falsificação acionada.** Manter
dois caminhos sem módulo comum duplicaria a lógica — e hoje já não há módulo
comum:

- `writeExportable` é chamado de dois lugares independentes: `src/cli.ts:421` e
  `src/onboarding/wizard.ts:292`. Nenhum compartilha decisão de destino, de
  colisão ou de erro.
- `listExportable()` (`src/skills/export.ts:7-9`) **é código morto**: o único
  chamador em todo o repositório é o próprio teste
  (`tests/skill-export.test.ts:11`).

Portanto: `export` continua (destino arbitrário, scriptável, sem manifesto), mas
`init`, `update` e `export` passam a compartilhar `src/skills/install.ts` com a
resolução de destino, a decisão cópia-vs-symlink, o cálculo de hash, a escrita e
a atualização do manifesto. Um `export --to <dir>` arbitrário **não** grava no
manifesto: destino fora dos destinos conhecidos não é algo que o `update` possa
manter.

---

## H5 — Quais skills, e a colisão de nomes

**Veredito: refutada como escrita, reformulada.**

### `workflow-authoring` não vai para harness nenhum

Ela **já é builtin do próprio runtime**: `src/commands/chat.ts:239-247` e
`src/commands/session-tools.ts:64-70` montam o `SkillStore` com
`assets/skills/workflow-authoring` como `builtinRoot`. Ela documenta
`run_workflow`, que é **tool de dentro do runtime** — o harness nunca chama
`run_workflow`, chama `lohra-ts chat`. Exportá-la colocaria no contexto do Claude
Code ou do Codex o manual de uma ferramenta que eles não têm. Fica onde está.

### A canônica para este runtime é `use-lohra-ts`

A colisão é real e já está no disco: `use-lohra` e `use-lohra-ts` coexistem em
`~/.claude/skills/` **e** em `~/.codex/skills/`; `~/.pi/agent/skills/` tem só
`use-lohra` (a do Python). O `diff` entre as duas mostra que a `use-lohra-ts` é a
mesma prosa com `lohra-ts chat --provider anthropic --profile
"lohra-ts-<project>"` no lugar de `lohra chat --profile "lohra-<project>"`.

Proposta: o lohra-ts shipa **uma** skill exportável, `use-lohra-ts`, e o `update`
**nunca** apaga `use-lohra` (é do Python, outro dono) — no máximo avisa que as
duas existem e o que cada uma dirige. Os limites de nome e descrição da spec são
folgados para ela: `description` tem 288 caracteres, contra o teto de 1024 do
OpenCode e do Pi.

---

## Três perguntas que só o owner responde

Nenhuma é decisão de implementador; as três bloqueiam E1.

1. **Qual é o nome do comando que a skill manda o harness executar?** O pacote
   declara o bin como `lohra` (`package.json:12-14`), que nesta máquina colide
   com o shim do Python em `~/.pyenv/shims/lohra`. As saídas são renomear o bin
   público (quebra de contrato), declarar um **segundo** bin `lohra-ts`, ou
   escrever `lohra` na skill e conviver com a colisão. Sem essa resposta, quem
   implementar E1 tem de adivinhar o que escrever dentro da skill.
2. **A descrição da `use-lohra-ts` desta máquina é "de coexistência"**: diz que,
   para um pedido simples de "use Lohra", o harness deve preferir a `use-lohra`,
   "which drives the Python runtime". Desde 2026-09-04 o lohra-ts é a mainline
   independente (CLAUDE.md). Essa deferência entra no repositório como está?
3. **A `use-lohra-ts` fixa `--provider anthropic` em toda invocação.** É uma
   decisão de rota gravada dentro de uma skill, e contradiz o `auth prefer` e a
   detecção de provedor do próprio runtime. Fica ou sai?

---

## Alternativas

### (a) Symlink em vez de cópia

**Veredito: adotada em parte — symlink para uma cópia canônica que o Lohra
possui, nunca para `assets/skills` do checkout.**

- **Symlink para o checkout: rejeitado.** `src/commands/update.ts:25-31` já
  devolve "not installed from a git checkout" para instalação por
  `npm install -g`: nesse caminho não existe alvo estável, porque o diretório do
  pacote global muda a cada versão. Pior, um `git checkout` de outra branch do
  lohra-ts trocaria em silêncio a skill que o harness carrega.
- **Symlink para `~/.agents/skills/use-lohra-ts`: adotado** para o Claude Code.
  É documentado (<https://code.claude.com/docs/en/skills>), o alvo é do Lohra e
  estável, e resolve de graça a duplicata no OpenCode. Fallback para cópia em
  Windows, onde symlink de diretório exige privilégio ou Developer Mode.
- Sondagem local que sustenta a viabilidade: `~/.claude/skills/` tem oito
  entradas que são symlink (`computer-use`, `find-skills`, `lavish`, `orca-cli`
  para `~/.agents/skills/…`; quatro `paperclip*` para um checkout) e
  `~/.config/opencode/skills/` tem onze, todas para `~/.agents/skills/`.
  Reproduzível com `ls -la <dir> | grep '^l'`.

### (b) Mecanismos nativos de cada harness

**Veredito: três mecanismos diferentes para quatro harnesses, e um deles não tem
nenhum — a cópia continua sendo o caminho único; os nativos entram como extras
depois de E1.**

- **Claude Code:** plugin + `.claude-plugin/marketplace.json` no repositório.
  Caminho legítimo e o mais "correto" a longo prazo, mas exige publicar e
  versionar um artefato à parte.
- **Codex:** plugin com `.agents/plugins/marketplace.json` e
  `codex plugin marketplace add owner/repo`. Além disso, o `$skill-installer`
  embutido instala de um repositório GitHub arbitrário — ou seja, **assim que
  `assets/skills/use-lohra-ts` existir no repositório, o usuário de Codex já
  consegue instalar sem nenhuma infraestrutura do lohra-ts**. Isso é ganho de E1,
  não de trabalho novo.
- **Pi:** `pi install npm:@…` / `git:…`; um pacote Pi declara skills pela chave
  `pi` do `package.json` e um diretório `skills/`. Como o lohra-ts **já é um
  pacote npm**, esse é o mecanismo nativo mais barato de todos — vale como
  sub-issue oportunista.
- **OpenCode:** **nenhum mecanismo de instalação de skill documentado.** O array
  `"plugin"` do `opencode.json` instala plugin npm de código, que é outra coisa.
  Copiar/linkar é a única via.

### (c) `lohra doctor` reportando skill desatualizada

**Veredito: sim, mas é consequência de A, não alternativa a ele.** O `doctor` não
tem como saber que uma skill está velha sem o manifesto — sem A, só saberia
comparando conteúdo em diretórios que ele não sabe que deve olhar. Com A, é um
check barato e read-only, e é o que dá valor a A mesmo para quem nunca rodar
`update`. Entra **junto** com A.

---

## Proposta de épicos

A ordem é dependência, não preferência. Nenhum é **L**.

| #   | título                                                                                                            | tamanho | depende de  |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------- | ----------- |
| E0  | decisão do owner: nome do comando, coexistência com o Python, `--provider` fixo (as três perguntas acima)         | —       | gate humano |
| E1  | fix: shipar `use-lohra-ts` e parar de exportar a skill do runtime Python                                          | **S**   | E0          |
| E2  | feat: entregar o comando que a skill exportada invoca (bin ou wrapper), conforme E0                               | **S**   | E0          |
| E3  | feat: detecção de harness cobre opencode e pi, e o destino compartilhado `~/.agents/skills` (doctor + onboarding) | **S**   | —           |
| E4  | refactor: `src/skills/install.ts` — destino, cópia vs. symlink, hash, escrita, num módulo só                      | **M**   | E1, E3      |
| E5  | feat: manifesto `~/.lohra/skills-install.json` e regra de sobrescrita                                             | **M**   | E4          |
| E6  | feat: `lohra init` com escolha de destino (lista numerada, `--harness`, `--no-harness`)                           | **M**   | E4          |
| E7  | feat: `lohra update` atualiza as skills instaladas e respeita edição do usuário                                   | **M**   | E5          |
| E8  | feat: `lohra doctor` reporta skill instalada desatualizada, ausente ou editada                                    | **S**   | E5          |
| E9  | feat (oportunista): declarar o lohra-ts como pacote Pi (chave `pi` no `package.json`)                             | **S**   | E1          |

E1 e E2 valem a milestone sozinhos mesmo que o owner recuse o resto: sem eles, a
funcionalidade que já existe é ativamente prejudicial.

---

## O que ficou inconclusivo

1. **Codex: doc × binário.** A documentação atual não menciona `~/.codex/skills`,
   mas o Codex instalado nesta máquina o usa e traz builtins em
   `~/.codex/skills/.system/`. Não apuramos a versão do Codex desta máquina nem
   se versões atuais ainda varrem esse caminho. A proposta contorna escrevendo em
   `~/.agents/skills` e só reportando o outro.
2. **Duplicata no OpenCode.** O OpenCode lê `~/.claude/skills` **e**
   `~/.agents/skills`. Se a mesma skill estiver nos dois como arquivo real, não
   sabemos se ele deduplica ou lista duas vezes — não está documentado. É a
   motivação do symlink, não uma verificação.
3. **Symlink em OpenCode e Pi: não documentado.** Há onze symlinks em uso em
   `~/.config/opencode/skills/` nesta máquina, mas não observamos o carregamento;
   para Pi não há nem indício. Claude Code e Codex documentam suporte.
4. **Windows não foi verificado.** O fallback "copia em vez de linkar" é hipótese
   de desenho, não medição — e a meta de produto inclui GUI Electron em Windows.
5. **`~/.pi/agent/skills/orchestration/` é um diretório sem `SKILL.md`.** Se o Pi
   ignora ou reclama, não sabemos.
6. **Versões dos harnesses não foram registradas.** A matriz mistura documentação
   de hoje com o disco de hoje; um harness desatualizado na máquina do usuário
   pode divergir.
7. **`src/skills/store.ts:53-70` escreve `version:` e `platforms:` como chaves de
   topo**, que não existem na spec (`name`, `description`, `license`,
   `compatibility`, `metadata`, `allowed-tools`). Sem impacto enquanto essas
   skills ficam dentro do runtime; vira problema no dia em que alguma for
   exportada para um harness. Não investigado nesta issue.

---

## Sondagens (reproduzíveis)

Todas locais, read-only, restritas a diretórios de skill conhecidos.

```sh
# identidade da skill exportável
grep -c 'lohra-ts' assets/skills/use-lohra/SKILL.md          # 0
diff assets/skills/use-lohra/SKILL.md ~/.claude/skills/use-lohra/SKILL.md | wc -l
git grep -l 'use-lohra-ts'                                    # vazio
git ls-files assets/skills

# onde as skills vivem em cada harness desta máquina
ls ~/.claude/skills ~/.codex/skills ~/.config/opencode/skills ~/.pi/agent/skills
ls ~/.agents/skills
ls ~/.codex/skills/.system

# symlink é usado na prática?
ls -la ~/.claude/skills ~/.config/opencode/skills | grep '^l'

# o comando que a skill validada invoca
which -a lohra lohra-ts
cat ~/.local/bin/lohra-ts
grep -n '"bin"' -A 4 package.json
```
