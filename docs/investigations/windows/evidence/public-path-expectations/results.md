# Representação pública de caminhos — #846

Base `419ac94850da1ad86d2bf9f651a7fb60c54fcc72`; vermelho compilável
`c0df6390e61d6bf112c1cdb9a02fa4ecf042f3a2`; verde
`7d06e08c977a1baf2a545bc8641d6162deb83153`. Os clones Node20 e Node22
instalaram dependências por ABI e usaram HOME, LOHRA_HOME, CODEX_HOME, cache
npm, TEMP e TMP próprios em F:. Nenhum teste ou código de produto fora dos
Files da issue foi alterado.

| Ensaio focal          | Windows Node20.20.2                                      | Windows Node22.23.2 |
| --------------------- | -------------------------------------------------------- | ------------------- |
| Base                  | exit 1; 2 arquivos/2 casos falhos, 11 pass               | mesmo resultado     |
| `test(red)` `c0df639` | typecheck 0; exit 1, 2 falhas e 11 pass                  | mesmo resultado     |
| Verde `7d06e08`       | build, typecheck, lint, format:check exit 0; prova 13/13 | mesmo resultado     |

No clone Linux Node22.23.3, UID 1000, o mesmo código `7d06e08` passou `npm ci`
e os cinco gates: 340 arquivos, 4.478 testes aprovados, 8 skips, 182,88 s;
prova 13/13. O controle negativo automático terminou exit 0 com **SKIP
mecânico** porque o diff é test-only (`base+overlay ≡ head`); o revisor pode
inspecionar o vermelho real `c0df639` medido nos dois Nodes Windows. Logs
Linux em `F:/lohra-846/linux-logs/`.

Na exportação `skill export use-lohra --to <destino>`, stdout real usa o
caminho nativo até `use-lohra/SKILL.md`: em Windows, `\` entre os componentes.
O esperado antigo acrescentava `/use-lohra/SKILL.md` ao destino, e os dois
Nodes o refutaram. A asserção final mantém o objeto completo exato
`{code:0, stdout:"wrote <caminho-nativo>\n", stderr:""}` e lê o SKILL.md
escrito para exigir `name: use-lohra`.

No erro de leitura de imagem, o handler emite um envelope JSON. A comparação
antiga procurava uma cauda Windows com `\` diretamente no texto JSON, que
escapa essas barras. O teste final faz parse do envelope, exige objeto com
apenas `error` string e compara sua mensagem com
`join("fixture", "unreadable.png")` e `EACCES: permission denied`. Continua
exigindo `failed to read image`, a redação de `sk123456` para
`<redacted-secret>`, ausência de stack e zero chamadas ao runner. Não há
normalização permissiva de separadores nem alteração de produto.

Comandos após `npm ci` no clone da ABI correspondente:

```text
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run prova -- windows-public-path-expectations
npm test -- --maxWorkers=1
npm run ci:controle-negativo -- --base 419ac94850da1ad86d2bf9f651a7fb60c54fcc72 --head 7d06e08c977a1baf2a545bc8641d6162deb83153 --branch test/846-windows-public-path-expectations
```

Logs brutos de baseline, vermelho e gates nativos estão em
`F:/lohra-846/`; os logs de baseline/vermelho contêm caminhos absolutos e
não foram versionados. Dogfooding de provider é N/A: a mudança toca apenas testes,
declaração de prova e documentação. CI e revisão independente serão
verificados na PR, não inferidos dos gates locais.
