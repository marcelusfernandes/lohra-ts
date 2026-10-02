# Proposta de backlog após W1–W7

Fichas **candidatas**, não issues criadas nem implementações autorizadas por esta investigação. Tamanho de cada ficha: **S**; se a revisão de código mostrar escopo M/L, decompor antes de abrir. Prioridade é ordem de desbloqueio (P0→P3), **não** label de severidade. Proofs abaixo são candidatos executáveis a criar na respectiva issue; não se afirma que esses slugs ou testes já existem. Cada prova roda no Windows nativo em Node 20/22 e mantém Linux/macOS verdes onde se aplica. Fontes: [W1](../../baseline.md), [W2](../../gates.md), [W3](../../terminal.md), [W4](../../runtime.md), [W5](../../durability.md), [W6](../../cron.md), [W7](../../distribution.md).

## Windows e harness de desenvolvimento

### W01 · Rename do arquivo reservado — P0

- **User Story:** como colaborador Windows, quero clonar o repositório com Git padrão para conseguir iniciar desenvolvimento sem desativar `protectNTFS`.
- **AC:** `git clone` padrão materializa árvore limpa em NTFS; imports, build, testes e catálogos de mutação referenciam o novo nome; clone contornado deixa de ser pré-requisito. **Proof candidato:** `npm run prova -- windows-clone` em clone descartável com Git padrão, seguido dos gates canônicos.
- **Files:** `src/agent/aux.ts` (rename), `src/agent/index.ts`, `src/conversation/runtime.ts`, `src/conversation/compaction.ts`, `src/commands/chat.ts`, `src/commands/dashboard.ts`, `scripts/mutations/context-window.ts`, `scripts/mutations/context-prompt-mutants.ts`, testes que importam o módulo, `prova/windows-clone.ts`. Inventariar demais referências antes da issue; não editar `docs/reference/` histórico.
- **Dependência:** nenhuma; desbloqueia todos os jobs e consumidores de source checkout. A causa está confirmada em W1.

### W02 · EOL de checkout e testes textuais — P0

- **User Story:** como mantenedor, quero que checkout Windows preserve o contrato de formatação e que testes de texto tratem line endings intencionalmente.
- **AC:** `.gitattributes` explicita LF nos arquivos de código/fixture que o formatter e testes consomem; `git ls-files --eol` confirma amostra; Prettier e os testes de texto antes sensíveis a CRLF passam em clone padrão Windows, sem desabilitar asserções úteis. **Proof candidato:** `npm run prova -- windows-eol` mais `npm run format:check` e teste regressivo em `tests/workflow-hardening.test.ts`.
- **Files:** `.gitattributes`, `tests/workflow-hardening.test.ts`, testes textuais afetados após inventário, `prova/windows-eol.ts`. Evitar conversão em massa sem diff controlado.
- **Dependência:** W01 para CI padrão. Causa confirmada por W2 para amostra mínima; não implica que todos os 366 testes falhos derivem de EOL.

### W03 · Lançador portátil de subprocessos npm — P0

- **User Story:** como mantenedor, quero executar npm de scripts internos no Windows para que mutações, provas e packcheck realmente cheguem ao trabalho que medem.
- **AC:** lançador resolve o npm compatível com Node atual em Windows e Unix, preserva argv/exit/stderr, e testes cobrem nome com espaço, erro de spawn e exit não zero; `mutations:all` inicia ao menos a primeira fatia e `pack:check` ultrapassa o primeiro spawn no Windows. **Proof candidato:** `npm run prova -- windows-npm-spawn` mais sondas de `npm run mutations:all` e `npm run pack:check` com limites próprios.
- **Files:** novo `scripts/subprocess/npm.ts`, `scripts/mutations/all.ts`, `scripts/pack-check.ts`, `scripts/prova/run.ts` se usar o mesmo launcher, testes de scripts, `prova/windows-npm-spawn.ts`.
- **Dependência:** W01/W02 para gates limpos; desbloqueia W04/W09. W2/W7 mediram `ENOENT` para `npm`; trocar só para `npm.cmd` produziu `EINVAL`, portanto implementação não está pré-escolhida.

### W04 · Caminhos internos da prova — P1

- **User Story:** como mantenedor, quero que a prova reconheça arquivos realmente executados em Windows sem aceitar arquivos ausentes.
- **AC:** caminhos do reporter e catálogo são comparados em formato interno estável; teste com `\\` e `/` prova que arquivo executado é reconhecido e arquivo ausente continua falhando; `npm run prova -- cancel-quiescente` não emite falso “did not run”. Falhas reais de assertion/`EBUSY` continuam visíveis. **Proof candidato:** `npm run prova -- windows-report-paths`.
- **Files:** `scripts/prova/vitest-relatorio.ts`, `tests/prova-vitest-relatorio.test.ts`, `prova/windows-report-paths.ts`.
- **Dependência:** implementação independente de W03; W2 já executou 48 assertions apesar do falso “did not run”. O gate/proof completo pode continuar expondo falha separada de launcher até W03.

### W05 · Wrapper do terminal em `cmd.exe` — P1

- **User Story:** como usuário da tool `terminal`, quero obter stdout, stderr e exit reais no Windows, inclusive cwd com espaço.
- **AC:** argv e quoting mínimos são reproduzidos e corrigidos; comandos controlados retornam `OUT`/`ERR`/7; timeout inicia o comando, encerra a árvore de processos e não deixa PIDs da sonda vivos; testes cobrem stdout grande, cwd Unicode e erro explícito. **Proof candidato:** `npm run prova -- windows-terminal` com teste nativo PTY, não mock de plataforma.
- **Files:** `src/tools/terminal.ts`, `tests/tools-local.test.ts`, `tests/tools-security-lifecycle.test.ts`, `prova/windows-terminal.ts`.
- **Dependência:** W01 para execução normal; W3 confirmou erro de sintaxe da tool nos dois Nodes, enquanto PTY direto passou. A causa exata de quoting ainda exige reprodução mínima.

### W06 · Contenção de caminho do workflow — P1

- **User Story:** como usuário de workflow, quero que arquivo filho da raiz permitida seja aceito e caminho fora dela negado no Windows.
- **AC:** política usa comparação de caminho de plataforma, cobre raiz/filho/irmão/prefixo parecido/symlink e drive distinto, mantendo recusa de egress; decisão explícita documenta que `terminal` não é sandbox de SO. **Proof candidato:** `npm run prova -- windows-workflow-root`.
- **Files:** `src/workflow/sandbox.ts`, `tests/workflow-sandbox.test.ts`, `tests/workflow-sandbox-refusals.test.ts`, `prova/windows-workflow-root.ts`.
- **Dependência:** W01; W3 confirmou uso de `resolvedRoot + '/'` como causa do filho negado. W5 pode acrescentar dependência de durabilidade, sem misturar políticas.

### W07 · Expectativas POSIX/JSON dos testes — P2

- **User Story:** como mantenedor, quero que testes Windows comparem propriedades de segurança e dados reais, sem falha por serialização de caminho ou bits POSIX inaplicáveis.
- **AC:** JSON de tools é parseado antes de comparar path; teste de permissão Windows valida ACL/propriedade adequada, mantendo teste POSIX onde faz sentido; nenhuma asserção de recusa é removida. **Proof candidato:** `npm run prova -- windows-tool-contracts`.
- **Files:** `tests/tools-local.test.ts`, `tests/tools-security-lifecycle.test.ts`, `tests/cron-store.test.ts`, `prova/windows-tool-contracts.ts`.
- **Dependência:** W05/W06 para separar falha real da tool de fragilidade de teste. W3 mediu escape JSON e `0o666` versus `0o600`; W6 mediu que `chmod 000` não torna arquivo ilegível no Windows.

### W08 · Hook de instalação no checkout — P2, hipótese

- **User Story:** como colaborador, quero diagnóstico fiel da instalação de hooks quando `npm ci` termina 0.
- **AC:** sonda isolada distingue shell ausente, spawn inválido e falha do hook; ou hooks instalam em Windows ou `prepare` declara opção não suportada com causa e status explícito, sem mascarar falha como sucesso. **Proof candidato:** `npm run prova -- windows-prepare`.
- **Files:** `scripts/prepare.mjs`, `tests/prepare.test.ts` (se criado), `prova/windows-prepare.ts`.
- **Dependência:** W01; W1 observou `exit null` em ambos os hooks, mas não estabeleceu causa raiz.

### W09 · Prebuild ConPTY no packcheck — P1

- **User Story:** como mantenedor de distribuição, quero que `pack:check` valide o binário que `node-pty` de fato distribui no Windows.
- **AC:** check específico de plataforma procura `conpty.node` em win32-x64 e mantém `pty.node` onde o pacote o fornece; consumidor carrega o addon e cria PTY real; falha quando artefato esperado é retirado. **Proof candidato:** `npm run prova -- windows-pack-pty` mais `npm run pack:check` em Node 20/22.
- **Files:** `scripts/pack-check.ts`, `tests/pack-check.test.ts`, `prova/windows-pack-pty.ts`.
- **Dependência:** W03; W7 não alcançou essa etapa do check, mas o código atual e pacote instalado demonstram a divergência estática. #559 é migração futura para versão estável com prebuilds Linux, **não** esta correção Windows.

### W10 · CI Windows informativo — P2

- **User Story:** como mantenedor, quero observar regressões nativas em PR sem bloquear branches antes de o baseline ficar verde.
- **AC:** job Node 20/22 Windows registra resultado de checkout, `npm ci`, gates e smokes com status legível; inicialmente informativo, sem mexer no ruleset; após critérios de saída no relatório, PR separada propõe torná-lo obrigatório. **Proof candidato:** execução do workflow em PR de teste e checks de configuração em `tests/ci-windows-checks.test.ts`.
- **Files:** `.github/workflows/ci.yml`, `tests/ci-windows-checks.test.ts`, documentação de CI em `README.md` se necessária.
- **Dependência:** W01/W02 para job que avance além do checkout/format; W03–W09 para virar obrigatório. Esta ficha não muda proteção de branch.

## Triagem antes de correção

### T01 · Ciclo de vida SQLite em testes — P1, causa aberta

- **User Story:** como mantenedor, quero saber qual handle mantém `state.db` ocupado após testes para corrigir cleanup sem enfraquecer asserções.
- **AC:** reproduzir `EBUSY` mínimo em Windows, rastrear abertura/fecho e distinguir teste de produto; só então issue de correção com expectativa de remoção após fechamento, sem retry cego. **Proof candidato:** `npm run prova -- windows-sqlite-cleanup` com arquivo temporário e verificação de handles/ordem de close.
- **Files:** `tests/gateway/prompt-submit.test.ts`, `tests/gateway/ws-connection.test.ts`, `tests/workflow-service-durability.test.ts`, `src/state/locks.ts` e repositórios de sessão apenas se o rastreio apontar para eles, `prova/windows-sqlite-cleanup.ts`.
- **Dependência:** W01/W02; W2/W4/W5 observaram `EBUSY`, mas não provaram causa única ou defeito de runtime. W5 mostrou 2 falhas em 89 testes dirigidos, ambas no cleanup de `workflow-service-durability`.

### T02 · Home `.lohra` e testes de compactação — P1, causa aberta

- **User Story:** como mantenedor, quero reproduzir o `ENOENT` do diretório `.lohra` com homes isolados para saber se é setup de teste ou resolução de path.
- **AC:** caso mínimo registra caminho calculado, criação, instante do `lstat`, exit e causa; correção posterior faz os testes de compactação passarem em Windows sem ler home pessoal. **Proof candidato:** `npm run prova -- windows-home`.
- **Files:** `src/config/paths.ts`, `src/media/persistence.ts`, `tests/chat-compaction-events.test.ts`, `prova/windows-home.ts`; editar produto só se diagnóstico confirmar.
- **Dependência:** W01/W02; W2/W4 mediram `ENOENT`, não sua causa. Os dois casos de compactação com exit 1 e os três de `cli-serve-process` exigem triagem por caso, possivelmente fichas separadas.

### T03 · Shutdown gracioso de dashboard/serve — P2, ainda não medido

- **User Story:** como mantenedor, quero comprovar que um encerramento suportado fecha conexões e estado antes de declarar o processo parado.
- **AC:** sonda Windows distingue `SIGTERM` que mata processo de handler que fecha servidor/transporte e devolve código 0; testa porta e estado pós-stop sem credencial real. **Proof candidato:** `npm run prova -- windows-server-shutdown`.
- **Files:** `src/commands/serve.ts`, `src/commands/dashboard.ts`, `tests/cli-serve-process.test.ts`, `prova/windows-server-shutdown.ts`, condicionados ao diagnóstico.
- **Dependência:** W01/W02; W4 provou apenas processo e porta fechados (`signal=SIGTERM`, `exit=null`).

### T04 · Triagem residual da suíte Windows — P2, causas abertas

- **User Story:** como mantenedor, quero uma lista deduplicada de falhas primárias após remover causas conhecidas para não transformar 366 assertions em 366 bugs.
- **AC:** repetir suíte Node 20/22 em clone padrão corrigido, registrar arquivo/teste/erro primário/exit e classificar cada família com reprodução mínima ou `INCONCLUSIVE`; separar `cli-serve-process`, compactação, permissões, sinais e cleanup sem mascarar falhas secundárias. **Proof candidato:** `npm test -- --maxWorkers=4` com relatório JSON sanitizado e `npm run prova -- windows-failure-triage` para checar cobertura da classificação.
- **Files:** `docs/investigations/windows/failure-triage.md`, `scripts/prova/windows-failure-triage.ts` (se automatizado), testes somente nas issues de correção posteriores. Este estudo não altera asserções do produto.
- **Dependência:** W01–W04 e, idealmente, W05/W06; W2 deu contagem, não causa individual. W4 registrou 3 falhas `cli-serve-process` e 2 compactações com exit 1 ainda sem diagnóstico.

## Bugs gerais, fora do milestone exclusivo Windows

### G01 · Entrada de biblioteca publicada — P2

- **User Story:** como consumidor de `lohra-ts`, quero que `import('lohra-ts')` e seus tipos resolvam conforme `package.json`.
- **AC:** `dist/index.js`/`.d.ts` existem no tarball ou `main`/`types` apontam para entradas reais; importação e TypeScript passam em consumidor sem `.git` nos Nodes da matriz. **Proof candidato:** `npm run prova -- package-library-entry` e `npm pack`/consumer isolado.
- **Files:** `package.json`, `src/index.ts` (se for a entrada escolhida), `tsconfig.build.json`, `tests/pack-check.test.ts`, `scripts/pack-check.ts`, `prova/package-library-entry.ts`.
- **Dependência:** definição do contrato público da biblioteca; W7 reproduziu falha de importação. Não é exclusivo Windows; não misturar com W09.

### G02 · Reivindicação atômica de job cron — P2

- **User Story:** como operador com dois schedulers, quero no máximo uma execução do mesmo job devido.
- **AC:** dois processos liberados por barreira executam o `once` uma vez; crash antes/depois de reivindicar tem política explícita; `last_run_at` não substitui reivindicação atômica. **Proof candidato:** `npm run prova -- cron-cross-process-once` em Windows e Linux.
- **Files:** `src/cron/scheduler.ts`, `src/cron/store.ts`, `tests/cron-scheduler.test.ts`, `tests/cron-store.test.ts`, `prova/cron-cross-process-once.ts`.
- **Dependência:** decisão sobre semântica de lease/ack; W6 mediu duas execuções também no Linux. Não usar label de severidade Windows.

### G03 · Recuperação de lock cron órfão — P2

- **User Story:** como operador, quero que crash do detentor de lock não trave leituras indefinidamente.
- **AC:** lock órfão é detectado por lease/fence ou política segura de recuperação; não rouba lock vivo; sonda filho morto retorna antes do timeout atual de ~10 s e preserva estado. **Proof candidato:** `npm run prova -- cron-orphan-lock` cross-process Windows/Linux.
- **Files:** `src/cron/store.ts`, `tests/cron-store.test.ts`, `prova/cron-orphan-lock.ts`.
- **Dependência:** desenhar fencing antes de recuperação; W6 mostrou lock persistente em ambas plataformas. Não remover diretório de lock de processo alheio sem verificação.

### G04 · Causa de falha do cron — P2

- **User Story:** como operador, quero ver a causa de callback e erro do loop para diagnosticar job falho.
- **AC:** `tick`/loop expõem fault com causa por sink ou estado consultável, sem registrar segredo; `last_run_at` na falha mantém a política atual salvo decisão separada. Testes verificam sentinel no diagnóstico e na superfície escolhida. **Proof candidato:** `npm run prova -- cron-error-cause` em Windows/Linux.
- **Files:** `src/cron/scheduler.ts`, `src/cron/tool.ts`, `src/commands/cron.ts`, `tests/cron-scheduler.test.ts`, `prova/cron-error-cause.ts`.
- **Dependência:** escolher superfície de diagnóstico; W6 reproduziu descarte de causa em Windows e Linux. Dashboard com provider não foi medido.

## Deduplicação e fronteiras de produto

Pesquisa `gh issue list --state open --search` em 2026-10-02 para `windows`, `aux.ts`, `pack-check`, `EBUSY`, `cron lock`, `spawnSync npm` e `formatter CRLF` não encontrou issue de **implementação** duplicada dessas fichas; #700–#708 são investigações. [#559](https://github.com/marcelusfernandes/lohra-ts/issues/559) cuida da migração `node-pty` estável com prebuilds **Linux** e exclui Windows; W09 não a substitui. [#619](https://github.com/marcelusfernandes/lohra-ts/issues/619) cobre TUI e futura matriz do renderer, que depende do núcleo mas não entra nestas fichas. [#654](https://github.com/marcelusfernandes/lohra-ts/issues/654) é medição live de cache Anthropic com crédito do owner, não valida os smokes Windows com stub. Reconsultar issues abertas antes de criar cada ficha; esta busca é uma fotografia, não uma reserva de número ou prioridade.
