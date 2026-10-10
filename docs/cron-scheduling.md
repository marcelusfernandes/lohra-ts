# Reivindicação de ocorrências de cron

`CronStore.tryClaimDue(id, now)` é a fronteira de exclusão entre schedulers. Sob
a guarda transacional do store, ele relê `jobs.json`, confirma que o job ainda
existe, está habilitado e satisfaz `isDue` no instante recebido, e grava
`last_run_at = now` por substituição atômica. Só depois da gravação devolve ao
chamador o snapshot **anterior** à reivindicação, para preservar o payload
entregue à execução. Ausência, desabilitação e ocorrência ainda não devida
retornam `null`; erros de leitura, parse, guarda ou persistência propagam.

No protocolo de reivindicação, `last_run_at` é o instante em que a ocorrência
foi reivindicada, **não** o instante em que o callback terminou. O contrato é
_at-most-once dispatch_ por ocorrência, não _exactly-once_ para efeitos
externos. Se um processo morrer antes de gravar a reivindicação, outro poderá
reivindicar; se morrer após a gravação e antes ou durante o callback, a
ocorrência poderá ser perdida e não terá retry automático. A recuperação
testada é de morte do processo, não de perda de energia ou disco: não há
garantia de `fsync` para esse último cenário.

Uma ocorrência `once` reivindicada não volta a ser devida. Um job `interval`
pode ser reivindicado na próxima janela de intervalo, e `cron` no próximo
minuto local válido. O marcador não impede sobreposição entre ocorrências
distintas se uma execução anterior continuar ativa. O scheduler chama
`tryClaimDue` antes de `runJob` e só despacha o snapshot devolvido ao vencedor.
Falha no callback produz `ok: false` e mantém a ocorrência consumida. A lista
inicial é apenas uma descoberta de candidatos: remoção, desabilitação ou mudança
de due antes do claim impedem o dispatch.

Falhas de callback emitem `cron job <id> phase=callback cause=<causa>`; falha ao
reivindicar emite `phase=claim` com o id e propaga; falhas de tick dentro do
loop emitem `cron scheduler phase=tick cause=<causa>` e o loop aguarda o próximo
intervalo. O diagnóstico usa o sink `diagnostics` quando fornecido e `console.warn`
quando omitido. Um sink que falha propaga sua própria exceção. A validação
inicial do store continua fora do loop e propaga imediatamente.

O campo `cause` é limitado a códigos conhecidos de filesystem/SQLite,
categorias fixas de `CronStoreError` ou ao tipo genérico `Error`/`TypeError`/
`RangeError`/`unknown`. Mensagens livres, paths, prompt e configuração não são
incluídos; códigos desconhecidos são reduzidos ao tipo. O id só é exibido se
tiver o formato hexadecimal gerado pelo store, senão vira `unknown`. Essa
sanitização permite identificar a fase e causas estruturadas sem registrar o
texto potencialmente sensível de exceções externas.
