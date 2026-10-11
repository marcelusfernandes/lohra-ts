# Validação nativa positiva explícita (#908)

`--native-positive` usa o CLI de `ci:controle-negativo` para compilar somente
o HEAD e executar a prova final no Windows. Ele reutiliza os validadores,
o preparo e a verificação do artefato de #904, bem como o harness confiável,
o relatório reconstruído e o cleanup. O rótulo `POSITIVE-ONLY` distingue
esta medição da comparação `assertion-red` de `--native`.

Exemplo com um repositório e compilador locais:

```text
npm run ci:controle-negativo -- --native-positive --root <REPO> --base <BASE> --head <HEAD> --slug <SLUG> --source native/value.cs --compiler <CSC_ABSOLUTO>
```

`BASE` precisa ser ancestral de `HEAD`. A lista de fontes é explícita e
validada; o comando direto não decide se o diff é elegível ao modo positivo.
Essa decisão pertence ao roteamento G2a2: mudança de C# de produção exige o
modo negativo de #904. O comando não escolhe o script `prova` nem hooks do
`package.json` do checkout: usa o entrypoint confiável já vinculado em #904.
Relatórios antigos são removidos antes da prova, e o resumo novo é conferido
contra o JSON do Vitest. A fixture cria apenas C# inofensivo que imprime
`GREEN`; não cria descendentes nem mede Job Object, árvore ou ACL.

O commit `0a0eca0` contém teste compilável e stub: a prova falhou por
`NATIVE_POSITIVE_NOT_IMPLEMENTED` antes da implementação. A primeira prova
expandida local classificou uma prova sem casos como erro do processo; o
reparo preservou o relatório fresco e retornou `NATIVE_PROOF_RESULT` com
`total=0`. Ambos os ensaios brutos ficaram fora do repositório em
`F:/lohra-m25-908/` e não são contados como PASS.

## Execução

| Sistema e ABI                  | SHA       | Medição                                                                                                                                                                                                                    |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Node 20.20.2, clone F: | `a28a9ee` | `npm ci`, build, typecheck, lint e format:check: exit 0; prova positiva 8/8 e negativa #904 19/19 em execução isolada.                                                                                                     |
| Windows Node 22.23.2, clone F: | `a28a9ee` | `npm ci`, quatro gates e prova positiva 8/8: exit 0; prova negativa #904: FAIL 1/19 por timeout Vitest de um caso legado (16,48 s).                                                                                        |
| Windows Node 22.23.2, WT C:    | `a28a9ee` | Prova negativa #904 com dependências próprias e home/temp separados: 19/19 PASS, exit 0.                                                                                                                                   |
| Linux não root, Node 22.23.3   | `a28a9ee` | `npm ci`, build, typecheck, lint e format:check: exit 0; suíte completa 346 arquivos, 4548 testes PASS, 29 skips; prova positiva 2/2 e negativa #904 7/7; controle negativo comum `assertion-red`: exit 0. C# Win32 é N/A. |

Os primeiros ensaios Windows paralelos à suíte Linux tiveram timeout Vitest
de 5 s em um caso da prova positiva Node22 (6,70 s) e um caso legado da
negativa Node20 (9,37 s). A repetição sequencial passou nos dois casos.
Isso não comprova que a concorrência foi a causa. A negativa Node22 no
clone F: também teve um timeout em caso legado durante uma execução
isolada. No mesmo clone, foco pareado de tal caso passou no SHA base
`8d8e23c` (1,39 s) e no candidato `a28a9ee` (1,76 s), ambos 1/1. A prova
completa passou no WT C: no mesmo SHA. As medições divergentes permanecem
como limite; não se atribui defeito ao drive nem se afirma estabilidade
geral da suíte Windows.

As provas nativas usam repositório Git descartável, fonte C# e teste reais,
inclusive chamada pelo comando npm. Testes injetados verificam falhas de
setup, relatório, prazo, sinal e cleanup sem deixar processos pendurados. A
prova negativa `controle-negativo-nativo` é executada separadamente para
conferir que o modo anterior continua intacto. O dogfooding do runtime é
N/A: o diff não altera `src/`, pacote ou lockfile.
