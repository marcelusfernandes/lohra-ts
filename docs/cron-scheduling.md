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
distintas se uma execução anterior continuar ativa. O scheduler existente só
passará a usar esta API na integração #760; até lá, a exclusividade aqui é da
reivindicação no store, não do dispatch fim a fim.
