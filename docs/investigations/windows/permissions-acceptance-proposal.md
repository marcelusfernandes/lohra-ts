# Proposta de critério de permissões no Windows (#852)

**Estado: proposta histórica; política aprovada pelo owner em 2026-10-11 e
registrada na [ADR 0006](../../adr/0006-windows-file-protection.md) (#895).**
Este documento não altera produto, testes, ACLs ou contas e não é aceite de
Windows. A confidencialidade NTFS entre duas identidades continua
**INCONCLUSIVE**. A aprovação da política não autorizou executar a bancada,
criar identidades, aplicar ACLs ou migrar homes existentes; essas ações exigem
decisão própria antes da execução.

## O que sabemos e o que falta medir

As APIs de `fs` recebem bits POSIX, mas no Windows o Node só manipula a
permissão de escrita por `chmod`, sem distinção entre owner, grupo e outros
([documentação Node 22](https://nodejs.org/download/release/latest-jod/docs/api/fs.html)).
No NTFS, uma tentativa de acesso depende dos direitos pedidos, do token da
identidade e do descritor de segurança do objeto; arquivos novos podem herdar
ACEs do diretório pai ([Microsoft: file security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights),
[ACLs](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-control-lists)).
Portanto, valor de `stat.mode`, chamada de `chmod` e acesso efetivo são três
observações diferentes.

| Camada                 | Fato da árvore ou medição                                                                                                                                                                                                                                  | Limite                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Intenção da API        | `src/auth/json-file.ts:36-49` abre temporário exclusivo com `0o600`, escreve, sincroniza e renomeia; `src/auth/store.ts:30-31,71,94-95` usa isso para `auth.json` e `oauth.json`.                                                                          | O argumento `0o600` não prova a DACL criada no Windows.                                                                |
| `.env`                 | `src/onboarding/env-write.ts:14-24,80-106` escreve o temporário com `0o666`, chama `chmod600` antes e depois do rename e engole falha do `chmodSync` real.                                                                                                 | Há bytes antes da tentativa de restrição; um spy de `chmod600` prova chamada/ordem, não proteção.                      |
| Lease e mídia          | `src/auth/lease.ts:42-52` abre lock com `0o600`; `src/media/persistence.ts:214-253` inicia stage com `0o600` e publica com `IMAGE_FILE_MODE=0o644`.                                                                                                        | Locks e arquivos de mídia pedem classificação própria; `0o644` não significa confidencialidade.                        |
| NTFS observado em #753 | Fixture dummy `mode: 0600` retornou `stat.mode & 0777 = 0666` em Node 20/22. `chmod(0400)` impediu **escrita** (`EPERM`) sem alterar o hash da DACL; a DACL herdada daquela fixture em F: incluía `AUTHENTICATED_USERS: Modify` e `USERS: ReadAndExecute`. | Medição de uma fixture, não regra de todos os homes. Leitura por outra identidade não foi executada; **INCONCLUSIVE**. |
| Regressão #746         | `tests/tools-local.test.ts:145-169` mede escrita permitida e recusa real em arquivo read-only, preservando bytes. `tests/cron-store.test.ts:60-79,112-129` injeta `EACCES` de leitura no Windows e usa `chmod 000` real no POSIX.                          | Recusa de escrita e injeção unitária não provam leitura negada por ACL nativa.                                         |

Os IDs do [inventário #751](failure-triage-inventory.md) permanecem vinculados
à medição original, sem reclassificação para PASS: `9615a59e06efa603` e
`9ce274db144486e7` (`auth-core`, expectativa `0600`),
`f1786e4f4ea8dc11` (`onboarding`, `.env` `0600`) e
`f9684bd9453e4c4f`, `cbbba63e7aa0ff97`, `917d0f7c4c289229`
(`media-persistence`, `0644`). Os outros dois IDs de `auth-core`,
`bf404c5bebe0bc54` e `aa384946ce7e4de9`, falharam em assertions de causa
de erro, não em comparação de modo; a [síntese #754](failure-triage.md) os
mantém **INCONCLUSIVE**. O [focal #753](failure-triage-platform.md) teve 7/46
falhas de permissões nos dois Nodes, incluindo esses dois ramos não explicados
pelos bits. Nada aqui atribui a eles uma causa de ACL.

## Proposta que fundamentou a política aprovada

A [ADR 0006](../../adr/0006-windows-file-protection.md) aprovou o critério de
proteção por **acesso efetivo de identidades distintas**, sem converter
`0600`/`0644` em uma fórmula de DACL. O detalhamento de implementação abaixo
continua proposto, sem autorização de experimento ou aceite. O processo
Lohra sob a identidade dona deve conseguir ler e atualizar seu estado. Outra
identidade local padrão, sem privilégios administrativos, não deve ler nem
escrever arquivos classificados como sensíveis. Não se promete isolamento
contra administrador, SYSTEM, privilégios de backup, malware no mesmo token ou
um processo que já recebeu os bytes. Esses limites devem acompanhar qualquer
declaração de suporte.

| Classe                                                                    | Leitura/escrita recomendada                                                                                                                                                                                                        | Publicação e verificação                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.json`, `oauth.json`, `.env` e temporários que contenham esses bytes | Identidade dona: ler e atualizar. Outra identidade local padrão: nem ler nem escrever. Acesso de SYSTEM/administradores pode ser necessário para administração/backup, mas fica fora da garantia de confidencialidade.             | Diretório/arquivo protegidos **antes** do primeiro byte; o runtime aplica e verifica metadados conforme a política, inclusive após rename. A bancada de aceite mede acesso efetivo com outro token. |
| `oauth.json.lock` e outros locks sob home de credenciais                  | Identidade dona: criar/ler/remover segundo lease existente. Outra identidade: sem escrita que permita interferir no fence; manter dentro do diretório protegido.                                                                   | Testar exclusão e limpeza sem enfraquecer `EEXIST`/falha explícita. Não inferir segredo no payload do lock, mas evitar que ele dê acesso ao home.                                                   |
| Imagens de mídia **explicitamente classificadas não secretas**            | Identidade dona: ler/escrever. Leitura por outra identidade só se o produto escolher publicação local explícita; escrita por outra identidade: negar. Se a mídia puder conter conteúdo privado, usar a classe sensível por padrão. | Preservar os testes POSIX de stage `0600` e final `0644`. Não tornar a mídia legível a terceiros no Windows apenas para imitar `stat.mode`.                                                         |

O caminho de implementação recomendado é um diretório de estado protegido,
resolvido a partir do home efetivo, antes de criar qualquer temporário com
conteúdo. Em Windows, a verificação deve considerar as ACEs herdadas e
explícitas, o token atual e o caminho final; `read-only` não basta. Uma camada
específica da plataforma deverá criar/verificar a proteção e devolver falha
causal. A escrita atômica, `fsync`, rename e lease já existentes continuam
obrigatórios. Diretórios intermediários criados pela aplicação também entram
na verificação; symlink/reparse, volume sem semântica NTFS comprovada ou caminho
cuja identidade não se consegue resolver não devem receber segredos por
suposição.

Os testes entre identidades pertencem à bancada de validação, não a cada
operação do runtime: a aplicação aplica/verifica a proteção do caminho e seus
metadados segundo a política aprovada, sem criar uma segunda sessão ou token
para cada escrita.

Para um `LOHRA_HOME` customizado ou home já existente, a aplicação futura
deverá inspecionar apenas metadados de caminho/descritor antes de usar o local.
Se a herança permitir leitura externa, não basta proteger o arquivo depois de
escrevê-lo. A proposta é oferecer migração explícita e transacional para um
subdiretório/arquivo protegido, com verificação antes e depois e sem cópia ou
backup em local amplo; até ela existir, operação sensível falha com causa e
instrução de reparo, sem ler nem imprimir credenciais. Uma migração não apaga
eventual exposição passada. Mudanças em ACL de arquivos preexistentes ou de
home escolhido pelo usuário exigem decisão de produto e autorização próprias;
este documento não as executa.

Se criar, aplicar ou verificar a proteção falhar, o comportamento recomendado
é não gravar novos bytes, não concluir refresh/login como persistido e não
seguir silenciosamente. Depois de uma falha parcial, liberar descritores e
tentar limpar **somente** temporários próprios; preservar a causa primária e
relatar também falha de cleanup sem incluir payload. Nunca usar `chmod`
best-effort como condição de sucesso de confidencialidade. A política foi
aprovada; alterar o comportamento atual de `.env` ainda requer implementação
em issue própria e prova do contrato.

Alternativas avaliadas na proposta:

| Opção                                                                          | Custo e consequência                                                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confiar na DACL herdada do perfil do usuário                                   | Menor implementação, mas não cobre home customizado, herança ampla ou migração; não satisfaz o critério entre identidades sem medição e validação por caminho. |
| Aplicar DACL explícita a cada arquivo depois da escrita                        | Mais simples de integrar, mas deixa janela de exposição no temporário e pode mudar a proteção após rename; não recomendada para segredos.                      |
| Diretório protegido antes dos bytes, com verificação do destino (recomendação) | Requer integração Windows específica, diagnóstico de herança/home e teste de ciclo de vida; permite falhar antes de persistir conteúdo.                        |
| Criptografia adicional do payload em repouso                                   | Pode reduzir exposição de bytes, mas introduz gestão de chaves e não substitui controle de acesso ao arquivo nem teste de identidade; decisão separada.        |

## Experimento proposto, ainda não autorizado

Antes de qualquer execução, o owner precisa aprovar **expressamente** criar
duas identidades locais descartáveis, aplicar/restaurar DACL **somente** em
fixtures novas e executar processos sob ambas. A bancada preferida é uma VM
Windows 11 descartável ou host de testes dedicado; usar este host pessoal só
se o owner o escolher expressamente, com recursos e descarte delimitados.
Esta proposta não autoriza criar contas no host atual. Uma chamada composta anterior
com `icacls`, sonda e cleanup foi rejeitada pela revisão automática **antes**
de executar, sem motivo granular; esta proposta não presume que ACL em si foi
bloqueada nem autoriza contorno por outra API. Sem aprovação e capacidade
demonstrada, o resultado permanece **NOT_MEASURED/INCONCLUSIVE**.

1. Criar um manifesto com UUID sob `F:\lohra-m25-permissions-<UUID>`, contendo
   apenas `home-a/`, `public-control/` e arquivos dummy (`auth.json`,
   `oauth.json`, `.env`, temporários e mídia sem dados pessoais). Verificar que
   o caminho resolvido e cada filho estão contidos nessa raiz nova; registrar
   volumes e identificadores sanitizados das duas identidades, ambas sem
   elevação. Nunca tocar home, credencial, ACL ou processo preexistente.
2. Medir primeiro o baseline herdado: descritor/ACEs sanitizados, tentativas
   de ler e escrever pelo token A (dono) e pelo token B (outro). Um controle
   deliberadamente público deve permitir leitura de B, provando que a
   identidade e o harness funcionam; um caminho ausente deve falhar por
   ausência, não ser confundido com `ACCESS_DENIED`.
3. Numa fixture **nova** preparada pela política candidata, repetir os
   controles: A lê e atualiza sem perder atomicidade; B recebe recusa nativa
   de leitura e escrita nos três arquivos sensíveis e em temporários **antes,
   durante e depois** do rename. Registrar código/causa, bytes dummy intactos
   e DACL antes/depois. Um arquivo de mídia classificado público segue a
   política aprovada, com leitura B positiva se essa opção for escolhida.
4. Injetar, só na fixture, falhas de criar/verificar proteção, de rename e de
   cleanup; confirmar ausência de novo arquivo sensível publicado, causa
   original visível e nenhum resíduo novo sem inventário. Repetir em Node 20
   e 22, Windows 11 x64, com no máximo 2 processos de sonda simultâneos,
   30 segundos por cenário, 5 minutos por ABI e 1 MiB de saída sanitizada por
   ABI; se exceder qualquer limite, terminar apenas filhos próprios e marcar
   o cenário INCONCLUSIVE com causa. Sem provider/rede.
5. Encerrar apenas filhos lançados pela bancada; conferir manifesto, caminhos
   resolvidos, handles fechados e contagem de arquivos antes/depois. Limpar
   só recursos próprios mediante autorização recebida, registrando falhas de
   cleanup; não apagar cegamente uma raiz calculada nem restaurar ACL alheia.

Aceite dessa bancada exigiria controles positivos e negativos coerentes em
ambas as ABIs, acesso real por dois tokens e ausência de janela de conteúdo
legível por B. Um resultado parcial fica FAIL ou INCONCLUSIVE com causa, nunca
PASS por inspeção estática da DACL ou por `stat.mode`. A leitura de descritor
é diagnóstico complementar; a tentativa efetiva é a prova da propriedade.

## Testes e trabalho futuro sugeridos

Os testes POSIX de `0600` em `auth-core`/`onboarding` e `0644` em
`media-persistence` permanecem no corpus POSIX; conteúdo preservado, escrita
atômica, erro causal e lease continuam cobertos. Um spy de modo prende intenção
e ordem, não substitui prova NTFS. #746 mantém sua recusa de escrita nativa e
seu `EACCES` unitário com os limites já declarados. Não se acrescenta skip
para esconder os IDs do inventário.

Estes recortes **S são propostas**, sem issues criadas ou trabalho iniciado.
O gate de política foi concluído na ADR 0006. A bancada entre identidades
continua sem autorização e as frentes de implementação dependem de issues
próprias:

| Recorte                                              | AC verificável                                                                                                                                                                                          | Files propostos                                                                                                        | Proof proposto                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Decisão de política (gate humano, não implementação) | Política aprovada pelo owner em 2026-10-11: identidade dona, outra identidade padrão, exceções de administração, mídia privada por padrão e falha explícita; execução da bancada segue sem autorização. | [ADR 0006](../../adr/0006-windows-file-protection.md), #895; nenhuma alteração de produto nesta issue.                 | Registro explícito da decisão e limites; sem teste artificial.                      |
| S1 — bancada dummy NTFS, após autorização            | Dois tokens não elevados: A lê/escreve, B não lê/escreve arquivo sensível, controle público B legível; temporário/rename e cleanup delimitados, Node 20/22, causas sanitizadas.                         | `scripts/probes/windows-permissions/**`, `docs/investigations/windows/evidence/permissions-two-identities/**`          | Sonda nativa com manifesto, JSON sanitizado e exit; não substitui gates do produto. |
| S2 — proteção Windows antes dos bytes                | Criar/verificar área e arquivos sensíveis antes da escrita; falha de ACL ou home incompatível bloqueia persistência com causa; testam-se herança e rename.                                              | `src/security/windows-file-protection.ts`, `tests/windows-file-protection.test.ts`, `prova/windows-file-protection.ts` | TDD + prova e cinco gates; bancada S1 confirma acesso efetivo.                      |
| S3 — integração auth/lease                           | `auth.json`, `oauth.json`, temporário e lock preservam atomicidade/fence e política aprovada; migração de home existente e erro de proteção são explícitos.                                             | `src/auth/json-file.ts`, `src/auth/lease.ts`, `tests/auth-core.test.ts`, `prova/windows-auth-protection.ts`            | Prova focal Node 20/22 + Linux, mutações da fatia e controles S1.                   |
| S4 — integração `.env`                               | Remover janela de bytes em `0o666` na política Windows aprovada; falha de proteção não vira sucesso silencioso, conteúdo/idempotência preservados.                                                      | `src/onboarding/env-write.ts`, `tests/onboarding.test.ts`, `prova/windows-env-protection.ts`                           | TDD de falha antes/depois do primeiro byte, prova e gates; controles S1.            |
| S5 — fixture de mídia por classificação              | Preservar assertions POSIX `0644` e conteúdo/atomicidade; no Windows medir leitura/escrita conforme política de mídia aprovada, sem inferir segredo a partir de bits.                                   | `tests/media-persistence.test.ts`, `prova/windows-media-access.ts`                                                     | Testes focais e prova em ambas as plataformas; controle de B quando autorizado.     |

Esta PR é somente documental. Prova executável e dogfooding real são **N/A**:
não há mudança em `src/**`, testes ou chaves de pacote lidas pelo runtime.
Os cinco gates canônicos em Linux e o CI da classe docs verificam integridade
do repositório, não confidencialidade NTFS. Até implementação e bancada
autorizada, #736 não deve usar este documento como aceite Windows.
