# ADR 0006: Proteção de arquivos sensíveis no Windows

- Status: aceita pelo owner em 2026-10-11, por aprovação explícita da política
  proposta em #852/PR #860: “Aprovar a política e registrar a ADR”. Registro
  acompanhado por #895.
- Data: 2026-10-11.
- Base: `6bb31c970ff985dd79a1d1617b639c658ceaf9ff`.
- Referência: [proposta e medições](../investigations/windows/permissions-acceptance-proposal.md).

## Contexto

O runtime usa modos POSIX como `0600` para estado de autenticação e `0644`
para alguns arquivos de mídia. No Windows, esses bits expressam intenção da
API, mas não demonstram a DACL nem o acesso efetivo de outra identidade. A
proposta #852 documentou essa distinção, inclusive uma fixture NTFS com
`stat.mode` divergente. Leitura entre duas identidades não foi medida: essa
propriedade permanece **INCONCLUSIVE**. Os testes POSIX, escrita atômica e
lease/fence continuam contratos do produto; a aprovação desta ADR não prova
que o Windows já os satisfaz junto da proteção definida abaixo.

## Decisão

1. **Acesso pretendido.** A identidade dona deve poder ler e atualizar seus
   arquivos sensíveis. Outra identidade local padrão, sem privilégios
   administrativos, não deve conseguir lê-los nem escrevê-los. Incluem-se
   `auth.json`, `oauth.json`, `.env` e qualquer temporário ou cópia que
   contenha os mesmos bytes. Locks no home de credenciais não podem permitir
   interferência na exclusão ou no fence. A garantia não cobre administradores,
   SYSTEM, privilégios de backup, malware com o mesmo token nem alguém que já
   recebeu os bytes.
2. **Proteção antes dos bytes.** A área e cada destino sensível, inclusive
   temporários, devem estar protegidos antes da primeira gravação. A proteção
   precisa continuar válida durante publicação por rename e no caminho final.
   A implementação futura deverá avaliar herança, diretórios intermediários,
   home customizado e caminhos existentes antes de persistir conteúdo. Se a
   identidade ou proteção do caminho não puder ser estabelecida e verificada,
   a operação sensível falha explicitamente com causa, sem considerar a escrita
   concluída. Falhas de limpeza de recursos próprios também permanecem
   observáveis, preservando a causa primária e sem expor payload.
3. **Mídia privada por padrão.** Arquivos de mídia podem conter conteúdo
   sensível e seguem essa classe por padrão. Publicação local legível por outra
   identidade exige classificação e escolha explícitas do produto; `0644` ou
   uma DACL herdada não constituem essa escolha. A decisão não modifica as
   asserções POSIX existentes de stage `0600` e final `0644`.
4. **Contratos preservados.** A proteção Windows deve coexistir com a escrita
   atômica, sincronização, rename, lease/fence e falha causal existentes. Não
   se aceita `chmod` best-effort, `stat.mode` ou inspeção isolada de DACL como
   prova de confidencialidade entre identidades. O runtime aplica e verifica
   metadados segundo a política; a prova de acesso efetivo por outro token
   pertence à bancada de aceite, não a cada operação de escrita.

Esta ADR define **o resultado exigido**, sem escolher uma API de ACL, um
formato de descritor, uma rotina de migração ou uma implementação específica.
Em home existente ou customizado incompatível, o comportamento sensível deve
falhar com causa até existir um caminho protegido comprovado; esta decisão não
autoriza modificar ACLs preexistentes nem migrar o home.

## Consequências e limites do aceite

A implementação e a validação ainda são trabalho futuro. A aprovação da
política não transforma os resultados históricos **INCONCLUSIVE** em PASS, não
declara suporte Windows e não fecha o aceite #736. O teste de confidencialidade
requer observar leitura e escrita reais com identidades distintas, controles
positivos e negativos e temporários antes, durante e depois da publicação. A
[proposta #852](../investigations/windows/permissions-acceptance-proposal.md)
contém uma bancada delimitada, mas executá-la, criar contas, aplicar ACLs ou
migrar homes existentes depende de autorização própria. Nenhuma dessas ações
foi autorizada por “Aprovar a política e registrar a ADR”.

## Alternativas consideradas

- Confiar apenas na DACL herdada não cobre home customizado ou herança ampla.
- Aplicar proteção só depois da escrita deixa uma janela com bytes expostos.
- Um diretório protegido antes dos bytes é um desenho candidato, ainda sujeito
  a implementação e verificação por caminho.
- Criptografia adicional exigiria uma decisão própria de chaves e não substitui
  controle de acesso ao arquivo.
