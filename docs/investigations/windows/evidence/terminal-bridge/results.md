# Bridge PTY Windows — evidência da #858

Base `4fc961ad1cdb2479605c1618d15c5465bd922c3b`; implementação
`1c3d98d624206413321765b8a5124d2570a08607`; candidato final antes
desta documentação `2e9e7c4fff868f44ef2286934742a0587b484ba2`. O código de
produção é idêntico nesses dois últimos SHAs (`git diff 1c3d98d 2e9e7c4 -- src` vazio).
Logs brutos locais: `F:/lohra-858/` (não versionados). Todos os testes temporários
usaram homes, cache e TEMP próprios em F:, sem credenciais.

| Ensaio                                        | Ambiente                                           | Resultado                                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Causa #851: PTY direta, parent cwd temporário | Windows 11 Pro build 26200, Node 20.20.2 e 22.23.2 | Envelope correto, remoção imediata EBUSY; recurso `conhost.exe` ainda ativo. Fonte externa `F:/lohra-851/diagnostic.md`.                                               |
| Vermelho `46ddf32` da bridge                  | Windows Node 22                                    | Teste de cwd temporário falhou por EBUSY, com envelope funcional; o stub ainda chamava executor direto.                                                                |
| Vermelho portátil `ec7a059`                   | Windows Node 22 e Linux Node 22                    | Typecheck Windows 0; prova exit 1 em ambos, por `not implemented: reject malformed worker envelope` em testes da bridge. Logs `red2-*` e `linux-logs/red-proof.log`.   |
| Clone ABI Node 20                             | Windows Node 20.20.2                               | `npm ci` e quatro gates 0 em `1c3d98d`; prova 17/17 em `2e9e7c4`.                                                                                                      |
| Worktree ABI Node 22                          | Windows Node 22.23.2                               | Quatro gates 0 em `1c3d98d`; prova 17/17 em `2e9e7c4`.                                                                                                                 |
| Source via TSX                                | Windows Node 20/22                                 | Teste real de cwd temporário, envelope e remoção imediata passou na prova.                                                                                             |
| Dist JS, sem loader TSX                       | Windows Node 20/22                                 | `dist-smoke.mjs`: `ok:true`, stdout `DIST_BRIDGE_OK\r\n`, stderr vazio, exit 0, `removed:true`. Resultados locais `node20-dist-smoke.json` e `node22-dist-smoke.json`. |
| Suíte completa, produção `1c3d98d`            | Linux Node 22.23.3                                 | 340 arquivos, 4442 testes passaram, 8 skips de plataforma; 206,27 s.                                                                                                   |
| Candidato `2e9e7c4`                           | Linux Node 22.23.3                                 | build, typecheck, lint, format:check e prova 10/10 passaram.                                                                                                           |
| Controle negativo inicial `1c3d98d`           | Linux                                              | Exit 1: a base não possui o módulo, e o primeiro vermelho não continha stub `throw` exigido pelo detector. Preservado em `linux-logs/negative.log`.                    |
| Controle negativo `2e9e7c4`                   | Linux                                              | Exit 0, `structural-red — PASS`; base estruturalmente vermelha e commit `test(red)` válido no range.                                                                   |
| `mutations:self-update` `2e9e7c4`             | Linux                                              | Exit 0, 12/12 mortos, 0 sobreviventes, `restoreGreen:true`; inclui T22-node-pty-bypass.                                                                                |

O segundo vermelho adicionou cobertura do envelope com `error` não textual. O
verde restaurou a produção byte a byte e adicionou a fronteira exata da
requisição: JSON mais `\n` de 65.536 bytes é aceito; um byte a mais retorna
fault. A suíte Linux inteira foi executada antes desses testes adicionais; o
resultado dela não é atribuído ao SHA final. Prova, gates leves, controle
negativo e mutação foram executados no SHA final.

Reprodução do smoke compilado após `npm ci && npm run build`:

```text
node docs/investigations/windows/evidence/terminal-bridge/dist-smoke.mjs <CHECKOUT>
```

`tests/windows-terminal-bridge.test.ts` é a reprodução source/TSX e dos casos
de falha: spawn ausente, EOF, frame e envelope malformados, crash/status,
limites de entrada/saída, timeout, `timeout:null` com resultado sem saída
natural, árvore própria encerrada e Unicode/50 mil code points em cada stream.
O worker não invoca `terminalTool` nem `ApprovalManager`. Nesta filha, a API
pública continua no executor direto; sua integração Windows é a #859.
