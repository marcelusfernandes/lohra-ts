# Gerenciar skills do Lohra nos clientes

Depois de instalar o Lohra, instale o kit TypeScript no cliente desejado:

```bash
lohra skills add OpenCode
lohra skills add "Claude Code"
lohra skills add Codex
lohra skills add Pi
```

Os nomes não distinguem maiúsculas e minúsculas; `Claude` também é aceito.
O cliente não precisa estar no PATH. Isso instala instruções para o cliente,
não o próprio cliente nem suas credenciais. OpenRouter é um provedor, não um
cliente para este comando. A escolha do destino não altera o provider, default
ou autenticação do Lohra.

`lohra skills --help` mostra as ações e clientes. O comando é global: não exige
provider configurado, credenciais ou inicialização de `state.db`, e não carrega
`.env` nem resolve o profile do Lohra. Argumentos inválidos retornam código 2
antes de escrever arquivos; sucesso e operações sem mudança retornam 0.

## Destinos

Cada destino recebe `use-lohra-ts/SKILL.md` e o registro local
`.lohra-managed.json`, sem segredos. A fonte é o asset empacotado
`assets/skills/use-lohra-ts/SKILL.md`.

| Cliente     | Diretório global padrão     | Override suportado                                                                          |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/skills`          | `CLAUDE_CONFIG_DIR/skills`                                                                  |
| Codex       | `~/.agents/skills`          | Não é alterado por `CODEX_HOME`                                                             |
| OpenCode    | `~/.config/opencode/skills` | `OPENCODE_CONFIG_DIR/skills`; raiz padrão também respeita `XDG_CONFIG_HOME/opencode/skills` |
| Pi          | `~/.pi/agent/skills`        | `PI_CODING_AGENT_DIR/skills`                                                                |

`~` representa o home resolvido pelo Lohra (`HOME`, ou o home do sistema).
Os overrides são variáveis de ambiente dos clientes; use caminhos absolutos.
OpenCode também pode descobrir skills em `.agents/skills` e `.claude/skills` do
home, e Pi pode descobrir `.agents/skills`. O diretório customizado OpenCode é
uma fonte adicional: remover uma cópia não garante que deixe de ser descoberta
por outra fonte compartilhada ou configuração do cliente.

Fontes dos caminhos: [Codex](https://learn.chatgpt.com/docs/build-skills),
[Claude Code](https://code.claude.com/docs/en/skills) e
[variáveis Claude](https://code.claude.com/docs/en/env-vars),
[OpenCode](https://opencode.ai/docs/skills/) e
[configuração OpenCode](https://docs.opencode.ai/docs/config/),
[configuração Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md).

## Atualizar e remover

```bash
lohra skills add OpenCode
lohra skills remove OpenCode
```

`add` instala em destino novo ou atualiza uma instalação gerenciada intacta
para o kit empacotado na versão atual do Lohra. Repetir com o mesmo conteúdo é
no-op. Não baixa skills remotas nem atualiza o próprio Lohra; depois de atualizar
o Lohra, execute `skills add` para atualizar a cópia desejada.

`remove` retira somente o arquivo gerenciado intacto e seu registro. Arquivos
extras e skills de terceiros permanecem; o diretório só é removido se vazio.
A mensagem confirma a remoção da instalação gerenciada e lembra que outras
fontes ainda podem disponibilizar uma cópia. Remoção já ausente é no-op.

Edição local, conteúdo sem ownership (mesmo idêntico) ou registro inválido gera
conflito, com saída 2 e preservação dos arquivos. Links/junctions nos caminhos
gerenciados são recusados. Não há adoção implícita, migração de ACL ou remoção
recursiva do home. Preserve suas alterações antes de decidir como resolver um
conflito; não existe opção `--force`.

Operações concorrentes usam lock exclusivo por destino físico. Um lock ocupado,
inclusive órfão, não é tomado automaticamente: inspecione o destino e os writers
antes de resolver o bloqueio. Falha parcial ou de cleanup é explícita; o comando
não tenta reparar automaticamente a instalação nem anuncia sucesso nessa falha.

A exportação manual continua disponível: `lohra skill export use-lohra-ts --to
<diretório>`. O comando singular também preserva a exportação explícita legada
`use-lohra`; ela não é o kit instalado pelos novos comandos de gestão.
