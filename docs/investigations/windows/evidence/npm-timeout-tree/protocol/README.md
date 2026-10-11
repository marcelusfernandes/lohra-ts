# #897 — protocolo v1 do helper npm Windows

Este contrato é um codec TypeScript **puro**, sem iniciar processos. O futuro helper .NET Framework e o adaptador devem consumir estes bytes; nenhum resultado aqui mede ownership, execução, startup de 300 ms ou compatibilidade com uma implementação C#.

## Frame e tipos

Cada frame começa com 9 bytes: ASCII `LNP` (3), versão **binária** `01` (1, não o caractere ASCII `1`), kind `01` request ou `02` result (1), e comprimento do payload `uint32` little-endian (4). O comprimento deve corresponder **exatamente** aos bytes restantes: truncamento e bytes extras são erros distintos. Não há flags no cabeçalho; flags de resultado desconhecidas são rejeitadas. Versão/kind desconhecidos falham antes de interpretar payload. Inteiros são unsigned little-endian; nenhum campo tem alinhamento ou padding. Strings são `uint32` byteLength seguido de UTF-8 estrito; bytes de stdout/stderr são `uint32` byteLength seguidos dos bytes opacos. O decoder rejeita UTF-8 inválido de metadados; o encoder rejeita substituição silenciosa de surrogate UTF-16 isolado. U+FEFF inicial é dado literal preservado, não BOM removido pelo decoder. Strings destinadas às APIs nativas rejeitam NUL. Não se decodifica nem normaliza stdout/stderr no codec.

Request, na ordem: `executable:string`, `cwd:string`, `argvCount:uint32`, `argvCount × string`, `envCount:uint32`, `envCount × (key:string,value:string)`, `timeoutMs:uint32`, `cleanupMs:uint32`, `stdoutLimitBytes:uint32`, `stderrLimitBytes:uint32`. A lista de ambiente explícita mantém a ordem. Key vazia ou contendo `=` é inválida; pares duplicados não são fundidos pelo codec, cabendo ao futuro lançador definir/rejeitar a semântica Windows antes de criar processo. Executável e cwd não podem ser vazios. `timeoutMs=0` significa sem prazo de execução, como a opção de timeout omitida no chamador atual; `cleanupMs` sempre deve ser positivo. A unidade dos dois é milissegundos. `stdoutLimitBytes` e `stderrLimitBytes` são limites **independentes** de bytes do filho; o resultado não pode exceder o teto de protocolo. Não há campo `signal` nem shell/command line interpolada.

Result, na ordem: `outcome:uint8`, `flags:uint8`, `pid:uint32?`, `status:uint32?`, `fault?`, `stdout:bytes`, `stderr:bytes`. Flags: bit 0 PID presente, bit 1 status presente, bit 2 containmentConfirmed, bit 3 fault.nativeCode presente; bits 4–7 são inválidos. `pid` e `status` são DWORDs completos, sem conversão para `int32` assinada; ausentes são `null`. Outcomes `0 exited`, `1 timeout`, `2 overflow`, `3 spawn-error`, `4 api-error`, `5 protocol-error`, `6 containment-error`. Para outcome distinto de `exited`, fault contém `phase:uint8` (`0 launch`, `1 run`, `2 cleanup`, `3 protocol`), `code:string` e `nativeCode:uint32?`. `code` é identificador ASCII `[A-Z][A-Z0-9_]{0,63}` e não mensagem, env ou payload. `exited` exige PID e status presentes, containment confirmado e fault ausente; não-exited exige status ausente e fault presente. Só `containment-error` admite containment não confirmado. Assim timeout só pode ser reportado depois de confirmar a contenção; caso contrário o produtor deve reportar `containment-error`. Isso **não infere** signal ou exit code. O futuro adaptador definirá a projeção para `SpawnSyncReturns<string>`.

## Tetos e falhas

Payload de request ≤ 1 MiB; cada string ≤ 16 KiB de UTF-8; até 1024 argumentos e 512 entradas env; timeout ≤ 24 h; cleanup de 1 a 60 000 ms. Cada stream de resultado ≤ 64 MiB, teto que cobre os chamadores atuais que passam `maxBuffer=64 MiB`, sem alegar equivalência irrestrita a Node. Payload de resultado ≤ 1 MiB + 2 × 64 MiB. O decoder verifica cabeçalho, comprimento total, contagens e comprimento de cada campo **antes** de decodificar ou copiar esse campo. O encoder valida números, strings, combinações e bytes antes de construir o frame final. Erros expõem somente `NPM_HELPER_PROTOCOL:<code>`, sem eco de env, stdout, stderr ou argumentos. Não há checksum; o transporte futuro deve entregar frame completo ou falhar fechado.

Exemplos canônicos em hex, também fixados por teste para outro implementador:

```text
request: executable="N", cwd="C", argv/env=[], timeout=0, cleanup=1, stdout/stderr limit=1
4c4e50010122000000010000004e0100000043000000000000000000000000010000000100000001000000

result: exited, pid=1, status=4294967295, containment=true, stdout=00ff, stderr=01
4c4e50010215000000000701000000ffffffff0200000000ff0100000001
```

Inválidos: versão `02` no quarto byte; request com comprimento declarado maior que os bytes reais; byte extra após o frame; string metadata `ff` isolado; string nativa com NUL; flags de resultado com bit 4; `exited` sem contenção confirmada; `timeout` com status, sem fault ou com contenção não confirmada. Os testes exercitam essas rejeições pelo codec, sem emular API Win32.

### Limites de evidência

Node 20/22 Windows e Node Linux validam exatamente o mesmo codec. Nenhum teste nesta folha lança o helper, verifica Job Object, compila C#, mede pipes reais, deadline ou distribuição no tarball. O módulo fica em `scripts/`, usado pelos scripts de desenvolvimento; `src/` e o pacote publicado não mudam.
