# Migração do lock de cron

O `CronStore` atual usa `jobs.json.guard.sqlite` para proteger toda a operação
síncrona sobre `jobs.json`, inclusive a substituição por rename. A transação é
liberada pelo sistema quando o processo morre. O formato de `jobs.json` não
muda. O diretório `jobs.json.lock` pertence à versão anterior: ele não registra
PID nem dono e pode representar tanto um processo ativo quanto um órfão.

Se `jobs.json.lock` existir, a versão nova recusa a operação com diagnóstico
explícito. Ela nunca remove esse diretório automaticamente. Não execute binários
antigos e novos simultaneamente no mesmo `LOHRA_HOME`: eles usam mecanismos de
exclusão diferentes.

Para migrar, faça uma janela **offline**:

1. Pare todos os processos antigos que possam ler ou escrever esse `LOHRA_HOME`.
   Confirme fora do Lohra que não há outro scheduler antigo ativo.
2. Faça backup de `cron/jobs.json` e confira que ele contém JSON válido. Não
   altere seu conteúdo como parte da migração.
3. Somente após confirmar que nenhum processo antigo está ativo, inspecione e
   remova manualmente o diretório `cron/jobs.json.lock`, se existir. Se não for
   possível confirmar a parada de todos os escritores, mantenha o lock e não
   inicie a versão nova nesse home.
4. Inicie somente a versão nova. O arquivo lateral `jobs.json.guard.sqlite`
   pode permanecer entre execuções; sua existência não indica posse ativa.

Uma falha de `SQLITE_BUSY` significa que outro processo novo ainda segura a
guarda. Ela expira após 2 segundos sem roubar a posse; aguarde o processo ou
investigue-o. Erros de abertura/IO são propagados com a causa original.
