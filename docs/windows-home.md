# Windows: home, profiles, credenciais e imagens

O Windows segue fora de suporte (README, "Instalação"). Esta página registra o
que o runtime faz hoje com o home, com as credenciais e com as imagens geradas
nesse sistema, conforme a [ADR 0006](adr/0006-windows-file-protection.md):
credencial e imagem só são gravadas em diretório protegido (acesso só do dono,
sem herança), e a proteção é verificada antes dos bytes. O Lohra nunca altera
nem migra a ACL de um diretório que já existe
(`docs/adr/0006-windows-file-protection.md:54-56`).

## O que o Lohra cria protegido

- **Home.** `chat`, `workflow` e `dashboard` abrem o estado (`state.db`) no home;
  se o diretório não existe, o Lohra o cria (`src/state/connection.ts:124`).
- **Profile.** `lohra profile create X` cria o diretório do profile
  (`src/onboarding/profiles.ts:20`).
- **Pasta de imagens.** `image_gen` grava em `<home>\images`
  (`src/commands/session-tools.ts:159`); se a pasta não existe, a primeira
  imagem a cria (`src/media/persistence.ts:245`). As regras próprias das
  imagens estão em "Imagens geradas".

Cada nível do caminho que ainda não existe nasce com acesso só do dono, sem
herança, e é verificado antes do próximo
(`ensureWindowsPrivateDirectory`, `src/security/windows-file-protection.ts:325`).
Um `LOHRA_HOME` customizado com pais inexistentes deixa esses pais restritos ao
dono. Nível que já existe não é alterado. Depois disso, `lohra auth prefer
api_key` e as demais gravações de credencial nesse home funcionam.

Se criar ou proteger falha, o comando para com `Could not create a private
Windows directory at <caminho>` e a causa, e o Lohra remove só o que ele mesmo
criou (`src/security/windows-file-protection.ts:336`, `:371`).

A criação protegida abre um `powershell.exe` para conferir o volume e mais um por
diretório criado. Salvar a primeira credencial em um home novo
(`lohra auth prefer api_key`) leva cerca de 2,5 s na máquina de referência, contra
cerca de 5 s antes da #953; com a máquina carregada a medição chegou a 3,5 s
(custo registrado na #942).

Fora a pasta de imagens, os demais pontos que criam diretório sob o home
continuam com `mkdir` comum e não foram medidos como primeiro criador (#941).

## Caminho ou volume que não pode ser protegido

Caminho UNC ou sem letra de unidade, com componente que tem `~` seguido de dígito
(nome curto 8.3, como `RUNNER~1`), terminado em ponto ou espaço, com `:` ou com
nome reservado do Windows (`CON`, `NUL`), ou em volume que não é NTFS fixo
(`pathRefusal`, `src/security/windows-file-protection.ts:114`;
`canBeProtected`, `:285`): o Lohra cria o home como antes, com `mkdir` e sem
proteção (`createUnprotected`, `:297`), e `chat`, `workflow` e `dashboard` abrem
normalmente.

Salvar credencial nesse home continua recusado, com causa, como manda a ADR 0006:
`Could not save private credentials at <caminho>` (`src/auth/json-file.ts:48-53`),
por exemplo com a causa `Windows private destination has an ambiguous path
component`. Gerar imagem também é recusado, ao contrário do home que abre sem
proteção (ver "Imagens geradas").

## Terminal elevado

A proteção define o usuário atual como dono do que ela cria, diretórios e arquivos
sensíveis (`auth.json`, `oauth.json`, `.env`, imagens geradas), também quando o
processo roda como administrador e o dono padrão do objeto novo seria o grupo
Administradores (`src/security/windows-file-protection-native.ts:85-87`). Por isso
salvar credencial em terminal de administrador funciona.

## Home preexistente com ACL herdada

Um diretório que já existe (home, base ou profile) com ACL herdada, por exemplo um
`%LOCALAPPDATA%\lohra` criado por versão anterior ou por outro comando, não é
alterado (`src/security/windows-file-protection.ts:331`), e salvar credencial nele
segue recusado com causa: `Could not save private credentials at <caminho>`, com a
causa `Windows ACL verify failed at <pasta>: Inherited access rules remain
enabled`. `chat`, `workflow` e `dashboard` continuam abrindo nele.

Esta página não traz orientação de reparo: a ADR 0006 não autoriza o Lohra a
alterar ou migrar a ACL, e o que dizer ao usuário nesse caso aguarda decisão do
owner ([#947](https://github.com/marcelusfernandes/lohra-ts/issues/947)).

## Imagens geradas

A mídia gerada é privada por padrão (ADR 0006, item 3): no NTFS os modos `0600` e
`0644` não protegem nada, então o Lohra aplica e verifica a ACL em vez de confiar
no modo.

- Quando é o Lohra que cria `<home>\images`, a pasta nasce com acesso só do
  dono, sem herança, como o home (`src/media/persistence.ts:245`).
- Cada imagem é criada vazia, protegida e verificada antes de receber bytes, e
  verificada de novo antes e depois de ser publicada (`src/media/persistence.ts:169`,
  `:329`, `:336`).
- Se a proteção ou a verificação falha, a imagem não é publicada: `image_gen`
  devolve o erro e o Lohra remove só o que ele mesmo criou.
- Cada imagem soma alguns segundos de proteção, feita em processos
  `powershell.exe` (custo registrado na #942).
- Fora do Windows nada muda: o arquivo temporário é `0600` e a imagem final
  `0644` (`src/media/persistence.ts:282`, `:327`).

**Pasta de imagens preexistente com ACL herdada**, por exemplo criada por uma
versão anterior que já gerou imagens, é recusada e não é alterada: `image_gen`
não grava e devolve a causa `Windows ACL verify failed at <pasta>: Inherited
access rules remain enabled`. As imagens que já estão nela não são migradas. A
orientação de reparo está pendente na mesma decisão do owner da
[#947](https://github.com/marcelusfernandes/lohra-ts/issues/947); esta página
não traz nenhuma.

**Caminho que não pode ser protegido** (as condições de "Caminho ou volume que
não pode ser protegido": componente 8.3 ou ambíguo, UNC, volume não fixo ou não
NTFS): ao contrário do home, que nesse caso abre sem proteção, gerar imagem é
recusado com causa, por exemplo `Windows private destination has an ambiguous
path component`, e nenhuma imagem é gravada.

## Biblioteca

`openStateDatabase`, exportado em `src/index.ts:4`, segue as mesmas regras no
Windows; o efeito para quem importa o pacote está em
[state-sqlite.md](state-sqlite.md#diretório-do-estado-no-windows).
