# Windows: home, profiles, credenciais e imagens

O Windows segue fora de suporte (README, "Instalação"). Esta página registra o
que o runtime faz hoje com o home, com as credenciais e com as imagens geradas
nesse sistema, conforme a [ADR 0006](adr/0006-windows-file-protection.md):
credencial e imagem só são gravadas em diretório que passa na verificação de
acesso, feita antes dos bytes. O que o Lohra cria nasce com acesso só do dono,
sem herança. O que já existe é aceito quando só o usuário, o SYSTEM e os
Administradores têm acesso (ver "Pasta preexistente"). O Lohra nunca altera nem
migra a ACL de um diretório que já existe
(`docs/adr/0006-windows-file-protection.md:54-56`); a emenda de 2026-11-04
(`:58-71`) mudou só a regra de aceite.

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
(`ensureWindowsPrivateDirectory`, `src/security/windows-file-protection.ts`).
Um `LOHRA_HOME` customizado com pais inexistentes deixa esses pais restritos ao
dono. Nível que já existe não é alterado nem tem a ACL inspecionada nessa
criação: quem o confere é a gravação de credencial ou de imagem (ver "Pasta
preexistente"). Depois disso, `lohra auth prefer api_key` e as demais gravações
de credencial nesse home funcionam.

Se criar ou proteger falha, o comando para com `Could not create a private
Windows directory at <caminho>` e a causa, e o Lohra remove só o que ele mesmo
criou (`ensureWindowsPrivateDirectory` e `cleanOwn`,
`src/security/windows-file-protection.ts`).

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
(`pathRefusal` e `canBeProtected`, `src/security/windows-file-protection.ts`):
o Lohra cria o home como antes, com `mkdir` e sem proteção
(`createUnprotected`, no mesmo arquivo), e `chat`, `workflow` e `dashboard`
abrem normalmente. A regra de "Pasta preexistente" não muda isso: a gravação é
recusada antes de qualquer verificação de ACL.

Salvar credencial nesse home continua recusado, com causa, como manda a ADR 0006:
`Could not save private credentials at <caminho>` (`src/auth/json-file.ts:48-53`),
por exemplo com a causa `Windows private destination has an ambiguous path
component`. Gerar imagem também é recusado, ao contrário do home que abre sem
proteção (ver "Imagens geradas").

## Terminal elevado

A proteção define o usuário atual como dono do que ela cria, diretórios e arquivos
sensíveis (`auth.json`, `oauth.json`, `.env`, imagens geradas), também quando o
processo roda como administrador e o dono padrão do objeto novo seria o grupo
Administradores (o ramo `protect` de `ACL_SCRIPT`,
`src/security/windows-file-protection-native.ts`). Por isso salvar credencial em
terminal de administrador funciona.

## Pasta preexistente

Um diretório que já existe (home, base, profile ou pasta de imagens) o Lohra não
altera. A gravação de credencial, a renovação do login OAuth e a geração de
imagem só o verificam, e a ACL dele decide (emenda de 2026-11-04 da ADR 0006,
decisão do owner na
[#947](https://github.com/marcelusfernandes/lohra-ts/issues/947)).

**Aceito** quando toda regra de acesso, herdada ou não, é `Allow` para o
usuário, o SYSTEM ou os Administradores, o dono é o usuário e ele tem controle
total (`Assert-Preexisting` em `ACL_SCRIPT`,
`src/security/windows-file-protection-native.ts`). Um `%LOCALAPPDATA%\lohra`
criado por versão anterior ou por outro comando, que só herda essas
identidades, passa: `lohra auth prefer api_key` e a renovação do OAuth gravam
nele, e um `auth.json` que já esteja lá, se também passa nessa regra, é
substituído por um arquivo novo, protegido (`prepareWindowsPrivateDestination`,
`src/security/windows-file-protection.ts`). A pasta fica como estava, com a
herança; o que o Lohra cria dentro dela (o arquivo de credencial, a imagem)
continua nascendo protegido, sem herança. Custo aceito na emenda: a herança
acompanha mudanças futuras no diretório pai. Cada gravação verifica de novo e
recusa se surgir uma identidade não aprovada, mas a leitura nesse intervalo
fica exposta.

**Recusado** quando alguma regra dá acesso a outra identidade. A gravação para
com `Could not save private credentials at <caminho>`, e a causa lista quem tem
acesso, com o nome e o SID (só o SID quando o nome não traduz), e diz o que
fazer:

```text
Windows ACL verify failed at <pasta>: Windows DACL grants access to unapproved identities: BUILTIN\Users (S-1-5-32-545). Move or rename this path so Lohra recreates it protected, or point LOHRA_HOME at a new path, then save the credential again
```

O nome segue o idioma do Windows (em pt-BR, `BUILTIN\Usuários`). Para obter uma
pasta protegida, mova ou renomeie a pasta, e o Lohra a recria protegida na
próxima vez que precisar dela; ou aponte `LOHRA_HOME` para um caminho novo.
Depois, salve a credencial de novo. Vale para o home, o profile e a pasta de
imagens (para esta, ver também "Imagens geradas"). Não há migração: o que estava
na pasta antiga fica nela, e o Lohra não a altera. `chat`, `workflow` e
`dashboard` continuam abrindo no home recusado; só a gravação sensível é
recusada.

Por que pode acontecer: `%LOCALAPPDATA%` pode herdar acesso de outras
identidades, por exemplo um grupo local de contas de sandbox de agente ou o SID
de capability de um AppContainer de app sandboxed. Um `%LOCALAPPDATA%\lohra`
criado com `mkdir` comum herda isso e é recusado. Mover ou renomear resolve
porque a pasta que o Lohra recria nasce sem herança.

**Continuam recusados**, com a causa de sempre e sem alterar a pasta:

- regra `Deny`: `Deny access rule cannot be verified`;
- dono diferente do usuário, por exemplo uma pasta que um terminal elevado criou
  com `mkdir` comum, cujo dono padrão é o grupo Administradores:
  `Windows file owner differs from the current identity`;
- usuário sem controle total: `Windows owner lacks full control`;
- reparse point em qualquer nível do caminho:
  `Windows reparse point is not verifiable`;
- volume que não é NTFS fixo: `Private destinations require a fixed NTFS volume`.

Caminho que não pode ser protegido segue como em "Caminho ou volume que não pode
ser protegido".

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

**Pasta de imagens preexistente**, por exemplo criada por uma versão anterior
que já gerou imagens, segue a regra de "Pasta preexistente". Se só herda o
usuário, o SYSTEM e os Administradores, `image_gen` grava nela e a pasta não é
alterada; as imagens que já estão nela ficam onde estão. Se dá acesso a outra
identidade, `image_gen` não grava e devolve a causa `Windows ACL verify failed
at <pasta>: Windows DACL grants access to unapproved identities: ...`, com a
mesma orientação: mover ou renomear a pasta para o Lohra recriá-la protegida.
Como a pasta é `<home>\images` (`src/commands/session-tools.ts:159`), apontar
`LOHRA_HOME` para um caminho novo também a leva para um caminho novo. O texto da
mensagem fala em salvar a credencial mesmo quando a pasta recusada é a de
imagens; nesse caso o passo seguinte é gerar a imagem de novo.

**Caminho que não pode ser protegido** (as condições de "Caminho ou volume que
não pode ser protegido": componente 8.3 ou ambíguo, UNC, volume não fixo ou não
NTFS): ao contrário do home, que nesse caso abre sem proteção, gerar imagem é
recusado com causa, por exemplo `Windows private destination has an ambiguous
path component`, e nenhuma imagem é gravada.

## Biblioteca

`openStateDatabase`, exportado em `src/index.ts:4`, segue as mesmas regras no
Windows; o efeito para quem importa o pacote está em
[state-sqlite.md](state-sqlite.md#diretório-do-estado-no-windows).
