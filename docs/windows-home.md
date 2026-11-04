# Windows: home, profiles e credenciais

O Windows segue fora de suporte (README, "Instalação"). Esta página registra o
que o runtime faz hoje com o home e com as credenciais nesse sistema, conforme a
[ADR 0006](adr/0006-windows-file-protection.md): credencial só é gravada em
diretório protegido (acesso só do dono, sem herança), e a proteção é verificada
antes dos bytes. O Lohra nunca altera nem migra a ACL de um diretório que já
existe (`docs/adr/0006-windows-file-protection.md:54-56`).

## O que o Lohra cria protegido

- **Home.** `chat`, `workflow` e `dashboard` abrem o estado (`state.db`) no home;
  se o diretório não existe, o Lohra o cria (`src/state/connection.ts:124`).
- **Profile.** `lohra profile create X` cria o diretório do profile
  (`src/onboarding/profiles.ts:20`).

Cada nível do caminho que ainda não existe nasce com acesso só do dono, sem
herança, e é verificado antes do próximo (`src/security/windows-file-protection.ts:266`).
Um `LOHRA_HOME` customizado com pais inexistentes deixa esses pais restritos ao
dono. Nível que já existe não é alterado. Depois disso, `lohra auth prefer
api_key` e as demais gravações de credencial nesse home funcionam.

Se criar ou proteger falha, o comando para com `Could not create a private
Windows directory at <caminho>` e a causa, e o Lohra remove só o que ele mesmo
criou (`src/security/windows-file-protection.ts:277`, `:312`).

A criação protegida abre alguns processos `powershell.exe` por diretório criado
(de 3 a 7 execuções): a primeira vez em um home ou profile novo leva alguns
segundos (custo registrado na #942).

Os demais pontos que criam diretório sob o home continuam com `mkdir` comum e não
foram medidos como primeiro criador (#941).

## Caminho ou volume que não pode ser protegido

Caminho UNC ou sem letra de unidade, com componente que tem `~` seguido de dígito
(nome curto 8.3, como `RUNNER~1`), terminado em ponto ou espaço, com `:` ou com
nome reservado do Windows (`CON`, `NUL`), ou em volume que não é NTFS fixo
(`src/security/windows-file-protection.ts:102`, `:226`): o Lohra cria o home como
antes, com `mkdir` e sem proteção (`:238`), e `chat`, `workflow` e `dashboard`
abrem normalmente.

Salvar credencial nesse home continua recusado, com causa, como manda a ADR 0006:
`Could not save private credentials at <caminho>` (`src/auth/json-file.ts:48-53`),
por exemplo com a causa `Windows private destination has an ambiguous path
component`.

## Terminal elevado

A proteção define o usuário atual como dono do que ela cria, diretórios e arquivos
sensíveis (`auth.json`, `oauth.json`, `.env`), também quando o processo roda como
administrador e o dono padrão do objeto novo seria o grupo Administradores
(`src/security/windows-file-protection-native.ts:62-64`). Por isso salvar
credencial em terminal de administrador funciona.

## Home preexistente com ACL herdada

Um diretório que já existe (home, base ou profile) com ACL herdada, por exemplo um
`%LOCALAPPDATA%\lohra` criado por versão anterior ou por outro comando, não é
alterado (`src/security/windows-file-protection.ts:272`), e salvar credencial nele
segue recusado com causa: `Could not save private credentials at <caminho>`, com a
causa `Windows ACL verify failed at <pasta>: Inherited access rules remain
enabled`. `chat`, `workflow` e `dashboard` continuam abrindo nele.

Esta página não traz orientação de reparo: a ADR 0006 não autoriza o Lohra a
alterar ou migrar a ACL, e o que dizer ao usuário nesse caso aguarda decisão do
owner ([#947](https://github.com/marcelusfernandes/lohra-ts/issues/947)).

## Biblioteca

`openStateDatabase`, exportado em `src/index.ts:4`, segue as mesmas regras no
Windows; o efeito para quem importa o pacote está em
[state-sqlite.md](state-sqlite.md#diretório-do-estado-no-windows).
