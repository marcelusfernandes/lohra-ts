# #898 — preparação explícita do helper (DEV-ONLY)

Código medido: `da4e4a4f8ca54078952aabdd867f5b8db6555288`, base
`24553e3dbcafc6a31a651751fd85db7f74418fc6`. O teste vermelho compilável
`6bcaae619f8d4cdb6336012495a9cc2ce4d3ff03` falhou 5/5 no stub
`not implemented`; o foco verde posterior passou 12/12 em Windows Node
20.20.2 e 22.23.2. Logs completos, clones e diretórios temporários próprios
ficam em `F:/lohra-m25-898/`, fora do repositório.

A API recebe fontes e destino **novo** do chamador. Ordena fontes sem mutar
a lista, recusa arquivo/reparse e compilador ausente, limita quantidade e
tamanho, e chama o `csc.exe` explícito com `shell:false`, `windowsHide:true`,
timeout e `maxBuffer` finitos. Grava manifesto com SHA-256 das fontes,
compilador e executável, além das opções; o descritor inclui SHA-256 do
manifesto. A verificação rehasha arquivos e **não executa** o binário.
Falhas distinguem timeout, buffer, lançamento, status e executável ausente.
Limpeza em falha toca somente `helper.exe`/`manifest.json` do diretório
criado; arquivo inesperado impede remover o diretório e causa
`PREPARE_CLEANUP_FAILED` com erro primário preservado. Destino preexistente
e ancestral reparse são recusados sem escrita.

Esta é preparação para scripts do checkout. Nenhum import inicia compilação;
`runNpmSync`, pacote, postinstall e CI não foram alterados. O descritor e
manifesto detectam alteração acidental/desatualização: **não** são barreira
contra atacante capaz de editar executável e metadados em conjunto. A fonte
trivial e a execução abaixo não testam Job Object, filhos, contenção, nem
o prazo de 300 ms da futura integração npm.

## Sonda nativa

[`probe.mts`](probe.mts) compila fonte C# própria que imprime
`LOHRA_898_OK` e sai com código 7. Recebe caminho absoluto do módulo
`prepare.ts`, diretório pai exclusivo externo e caminho do `csc.exe`.
Exemplo com Node e dependências da mesma ABI:

```powershell
$node = '<NODE20_OU_22>/node.exe'
$tsx = '<CHECKOUT>/node_modules/tsx/dist/cli.mjs'
& $node $tsx '<CHECKOUT>/docs/investigations/windows/evidence/npm-timeout-tree/bootstrap/probe.mts' '<CHECKOUT>/scripts/subprocess/windows-helper/prepare.ts' '<TEMP_EXCLUSIVO>/probe' 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
```

| Node    |     `csc` | Início do exe | Exit/stdout/stderr         | Resultado |
| ------- | --------: | ------------: | -------------------------- | --------- |
| 20.20.2 | 260,86 ms |      92,46 ms | 7 / marcador exato / vazio | PASS      |
| 22.23.2 | 255,28 ms |      96,31 ms | 7 / marcador exato / vazio | PASS      |

[`node20.json`](node20.json) e [`node22.json`](node22.json) preservam
comando, argumentos sanitizados, versões, hashes, tempos e saída. O hash do
executável difere entre compilações, embora fonte e compilador sejam os mesmos;
cada manifesto corresponde à própria compilação. Estes tempos **não** medem
helper real nem o deadline de `runNpmSync`.

## Gates

Nos dois Nodes Windows, `npm run build`, `typecheck`, `lint`,
`format:check` e `npm run prova -- windows-npm-prepare` saíram 0,
prova 12/12. Node 20 usou clone e `npm ci` próprios; Node 22 usou o worktree.
Ambos isolaram HOME, USERPROFILE, LOHRA_HOME, CODEX_HOME, TEMP/TMP e cache npm
em `F:/lohra-m25-898/`. O Node 22 instalou dependências com
`npm ci --ignore-scripts`; os addons necessários carregaram. O Node 20 usou
`npm ci` normal. Linux: a prova nativa `csc.exe` é N/A; os contratos
portáteis rodam por injeção explícita, sem simular Win32. Em clone próprio
`/work/lohra898`, usuário `node`, os cinco gates Linux saíram 0;
a suíte completa passou 343 arquivos, 4520 testes e 9 skips em 246,95 s
(`--maxWorkers=1`), e a prova passou 11/11. O controle negativo saiu 0
com `structural-red — PASS` na base: o arquivo novo de teste não encontra
o módulo novo; o commit `test(red)` anterior registra falha em runtime
contra o stub compilável. O controle negativo, portanto, não é uma segunda
execução do stub, e não deve ser descrito como `assertion-red`.

Os logs nativos e Linux completos permanecem em `F:/lohra-m25-898/`.
Os cinco gates Linux mediram o mesmo código de produto `da4e4a4`;
esta documentação foi acrescentada depois da medição e sua formatação é
validada separadamente antes da PR.
