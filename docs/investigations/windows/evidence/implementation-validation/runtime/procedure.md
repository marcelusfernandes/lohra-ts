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

O resultado é **PARTIAL**. A correção #920 e a repetição do passo 2–4 com
pacote corrigido ainda não foram registradas aqui. Este procedimento não
mede cancelamento de chamada remota já enviada, cron, gateway amplo,
compactação, crash/lease ou ACL entre identidades.
