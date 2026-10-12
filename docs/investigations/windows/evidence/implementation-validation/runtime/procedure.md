# Evidência sanitizada de #757

Os JSONs desta pasta projetam somente campos necessários das saídas locais
`F:/lohra-product-dogfood-20261011-40bdda/evidence/`. Os originais incluem
prompts e caminhos locais e permanecem fora do repositório. Nenhum arquivo de
autenticação, `.env`, banco ou transcrição integral foi copiado.

O pacote `lohra-ts 0.0.13` do candidato `247d6c2` foi instalado em diretório
externo ao checkout. Windows x64, Node `22.23.2`, `LOHRA_HOME` próprio e provider
real Codex `gpt-6-sol`. `doctor --json` retornou exit 0 e `usable=true`.

1. A rodada anterior #913 executou `chat --json` sobre `vendas.csv` fictício.
   Houve `read_file`, dois `write_file` e um `terminal` de conferência, com
   total R$ 124,50 e 15 unidades. A retomada da mesma sessão lembrou o
   contexto; outra home não conhecia o código de continuidade. Projeção:
   [product-outcome.json](product-outcome.json).
2. Na mesma sessão, o prompt da medição #757 pediu um `write_file` de
   `checkpoint.txt`, depois `terminal` para `node operacao-limitada.cjs`.
   A [fonte da operação](operation-source.cjs) grava início e pulsos locais a
   cada 500 ms e só grava conclusão natural após 30 s. O script usa arquivos
   fictícios no diretório corrente e não acessa rede.
3. Depois de observar o início, foi enviado Ctrl+C ao PTY do `chat`. O primeiro
   controle ocorreu 6,941 s depois: PID 75060 morto, nenhum marcador de
   conclusão natural, checkpoint preservado. O PTY saiu 1 sem envelope de
   cancelamento. Projeção: [cancel-observation.json](cancel-observation.json).
4. Nova execução de `chat --json --session <mesma sessão>` pediu somente
   `read_file checkpoint.txt`. Exit 0, `completed=true`, `error=null`, uma
   chamada `read_file`; não houve replay do `terminal`. A resposta citou uma
   falha de fixture anterior em vez de um aviso persistido de cancelamento.
   Uma consulta **somente leitura** contou zero mensagens de usuário do turno
   interrompido e uma da retomada. Projeção:
   [resume-observation.json](resume-observation.json).

A primeira tentativa da etapa 2 usou a fixture em pasta diferente do cwd
congelado da sessão e falhou com `MODULE_NOT_FOUND`. Ela foi corrigida antes
da medição de Ctrl+C; não é evidência de falha do runtime.

Depois, o candidato `a8c44ce` de #920 repetiu somente o trecho afetado com o
pacote instalado. Ctrl+C via ConPTY público retornou em 1.430 ms, exit 1,
`completed=false` e `error="conversation cancelled"`; child encerrado,
sem conclusão natural, `entrega-final.txt` preservado. O notice `cancelled`
foi persistido e recebeu ack. A retomada leu o arquivo com `read_file`, sem
replay, mas interpretou a falha antiga como execução recente. #920 foi
integrada pela PR #922 no merge `2c5e7c4`.

Os candidatos locais `87221df` e `ec5a2b3` de #923 repetiram a sequência
focal em 1.426 ms e 1.922 ms. Ambos encerraram o child e preservaram o
arquivo; ambos tiveram retomada operacional com `read_file`, sem replay.
As respostas, porém, trataram o aviso de operador como suspeito e não
identificaram com segurança a interrupção recente. Os dados projetados estão
em [followup-observations.json](followup-observations.json). Suas fontes locais
são `cancel-{final,context,factual}-meta.json` e os respectivos
`cancel-{final,context,factual}-resume.json` no diretório de evidências externo.

O candidato `bd1181e` de #923 aplicou a escolha explícita do owner: mostrar
o aviso de sessão na apresentação determinística da CLI, antes da resposta
do modelo, e em `session_notices` no envelope JSON. Uma execução real
cancelou em 1.882 ms com exit 1 e `conversation cancelled`; child encerrado,
sem conclusão natural, `entrega-aviso.txt` íntegro. A retomada humana exibiu
o aviso primeiro e terminou com exit 0. A apresentação JSON do mesmo evento
foi conferida a partir de snapshot independente do estado e de três arquivos
de configuração de autenticação, sem segunda operação de cancelamento. Ela
terminou com exit 0, `completed=true`, `error=null`, duas chamadas ao provider,
somente `read_file` como ferramenta e
`session_notices` contendo `id=5`, `kind=cancelled`. Nenhum conteúdo desse
snapshot foi copiado. Projeção:
[notice-observation.json](notice-observation.json). Fontes externas:
`cancel-notice-meta.json`, `cancel-notice.json`, `notice-resume-human.txt`,
`notice-resume-human.exit.txt`, `notice-resume-json.json` e
`notice-resume-json.exit.txt`.

O resultado funcional restrito de #757 é **PASS no CLI instalado**,
conforme a apresentação escolhida pelo owner. #923 foi integrada pela PR #924
no merge `d7ae0a9d6fa41054425d6ca3cdc208f113d5ab6f`. O resultado não
depende de o modelo interpretar o aviso. Estas
execuções não medem TUI, cancelamento de chamada remota já enviada, cron,
gateway amplo, compactação, crash/lease ou ACL entre identidades.
