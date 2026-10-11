# #850 — cwd da fixture de timeout

## Árvores e isolamento

- Base: `03e579d2cca00b6da23c4ed664e5698555e00c36`.
- Teste vermelho compilável: `119d49dfa7458547c04a1ba3d06c8a27879d88f2`.
- Candidato de código/teste: `a37863617b05bf4c0e7d57723308970ae95530c9`.
- Windows: clones descartáveis separados em `F:/lohra-m25-850/clone20` e
  `clone22`, cada um com `npm ci` próprio, Node 20.20.2 e 22.23.2. `HOME`,
  `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, cache e prefixo npm
  foram próprios de cada clone em F:. Não houve provedor externo.
- O worktree de autoria tem `node_modules` regular, sem junction.

## Vermelho e mecanismo

`vitest run tests/eval-session-internals.test.ts --maxWorkers=1` compilou
(`typecheck` exit 0) e falhou em ambas as versões: 4/5 testes passaram.
`rmSync(rootA)` em `:75` lançou `EBUSY`; o `afterEach` em `:28` registrou
outro `EBUSY` ao tentar remover a mesma raiz. Logs completos:
`F:/lohra-m25-850/red-committed-{20,22}.log`. A ordem era timeout de A,
`cwd=rootA`, remoção de A sem `chdir`, antes de B ou da conclusão de A.

A sonda isolada `F:/lohra-m25-850/cwd-control.cjs`, em ambas as ABIs, criou
uma raiz temporária, fez `chdir(root)`, tentou `rmSync(root)`, restaurou o cwd
inicial e repetiu `rmSync(root)`. Retorno: `first=EBUSY`, `second=removed`,
`restored=true`. Essa sonda só toca seu próprio diretório temporário.

## Contrato final

O caso A ainda está pendente após o timeout real de 5 ms. O caso B inicia
enquanto `cwd=rootA`; antes de qualquer restauração corretiva feita pelo
teste, `resultB.exitCode=0`, `timedOut=false` e `cwd=startedAt` são exigidos.
Só então a fixture restaura `startedAt`, remove A e B, resolve A tardiamente,
drena uma volta do event loop e exige nenhuma rejeição não tratada e cwd
final estável. Isso espelha a ordem de `runEvalCase` em
`scripts/eval/session.ts:490-491` sem remover o cwd ativo no Windows.

O `finally` também resolve A se uma asserção anterior falhar, aguarda uma
volta delimitada de `setImmediate` com o listener ainda ativo, restaura cwd
antes das remoções e agrega erros de limpeza à causa primária. A sonda de
asserção forçada trocou somente `expect(resultB.exitCode).toBe(0)` por
`.toBe(1)` em clones próprios: ambos saíram com a `AssertionError` original,
sem `EBUSY` e com zero diretórios da fixture residuais. O teste original foi
restaurado por cópia byte a byte e hash SHA-256 igual. Logs:
`F:/lohra-m25-850/assertion-failure-{20,22}.log`.

## Controle discriminante

Em cada clone descartável, antes de rodar o focal, uma sobreposição temporária
**somente** em `scripts/eval/session.ts` simulou a regressão #607:

```ts
const previousCwd = process.cwd(); // imediatamente antes de process.chdir(cwd)
// No finally da invocação, em vez de restoreProjectRootCwd():
process.chdir(previousCwd);
```

O teste final falhou 1/5 em Node 20 e 22, exatamente em
`expect(process.cwd()).toBe(startedAt)` após B: recebeu a raiz A. Não houve
`EBUSY`; o `finally` do teste restaurou cwd e removeu as raízes. O arquivo de
produto original foi reposto após a medição, com SHA-256 idêntico antes e
depois (`219FD24BE66E99DF554FF10FDC54DD897280467291E91F4E9C6BF97859DFB96E`).
Logs: `F:/lohra-m25-850/dynamic-negative-{20,22}.log`. Nenhum byte de
produto alterado integra a branch.

## Gates

| Ambiente                           | `npm ci` | build | typecheck | lint | format:check |  prova |
| ---------------------------------- | -------: | ----: | --------: | ---: | -----------: | -----: |
| Windows Node 20.20.2               |        0 |     0 |         0 |    0 |            0 | 0, 5/5 |
| Windows Node 22.23.2               |        0 |     0 |         0 |    0 |            0 | 0, 5/5 |
| Linux Node 22.23.3, usuário `node` |        0 |     0 |         0 |    0 |            0 | 0, 5/5 |

Os comandos nativos foram `npm run build`, `typecheck`, `lint`,
`format:check` e `npm run prova -- windows-eval-cwd-restore`, cada ABI com
`npm ci` e ambiente isolados. Logs completos em
`F:/lohra-m25-850/native-{20,22}-*.log`; resumos `.prova` nos próprios
clones. No Linux, o bundle do SHA `a378636` foi clonado separadamente em
`/work/lohra850` no container `lohra-m25-linux-737-20261009`, com
`HOME`/`LOHRA_HOME`/`CODEX_HOME`/`TMPDIR` e cache isolados sob `/tmp/lohra850-*`.
`npm test -- --maxWorkers=1` terminou exit 0: 340 arquivos, 4490 testes
aprovados e 8 ignorados, em 170,45 s. `npm run prova --
windows-eval-cwd-restore` terminou exit 0, 5/5. O controle negativo com
`--base 03e579d --head a378636 --branch
test/850-windows-eval-cwd-restore` terminou exit 0 com **SKIP test-only**:
base+overlay equivale ao head; o vermelho nativo e a sobreposição
`previousCwd` são a evidência discriminante comportamental. Logs completos
em `F:/lohra-m25-850/linux-evidence/` (`results.tsv`, `test.log`,
`prova.log`, `negative.log`). O wrapper de coleta saiu com exit 1 apenas
porque sua última linha `cat results.tsv` recebeu CRLF extra; todos os sete
comandos medidos antes dela têm exit 0 no TSV, e a suíte não foi repetida.
Dogfooding real: N/A — apenas teste, declaração de prova e evidência.
