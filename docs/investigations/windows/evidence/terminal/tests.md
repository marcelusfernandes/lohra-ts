# Evidência de testes existentes — #703

SHA do código medido: `fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`.
Windows 11 x64 nativo. Os dois clones temporários têm o mesmo SHA; nenhuma
modificação de código foi feita neles. Os resultados abaixo são observados,
não projetados.

Comando Node 20:

```powershell
& 'C:\Users\marce\AppData\Local\Temp\lohra-w701\node-v20.20.2-win-x64\node.exe' .\node_modules\vitest\vitest.mjs run tests/tools-local.test.ts tests/tools-security-lifecycle.test.ts
```

Executado no clone temporário `clone-workaround`. **Exit 1**, 2 arquivos de
teste com falha, **21 pass / 7 fail**. Duração 14,00 s.

Comando Node 22: trocar o executável por
`...\node-v22.23.3-win-x64\node.exe` e executar no clone temporário
`clone-workaround-22`. **Exit 1**, 2 arquivos com falha, **21 pass / 7 fail**.
Duração 15,04 s.

Falhas iguais nas duas versões:

| Teste                                 | Resultado observado sanitizado                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools-local`: write_file bytes/path  | Esperado interpola `C:\...` literalmente; resultado JSON válido escapa como `C:\\...`. Falha byte a byte; a sonda de leitura/escrita parseada passou. |
| `tools-local`: stdout/stderr/exit     | Esperado `out`/`err`/7; observado `"stdout":"","exit_code":1` e erro de sintaxe do `cmd.exe`.                                                         |
| `tools-local`: gate perigoso          | Mesma diferença de escape JSON no campo `command`; recusa sem execução foi confirmada na sonda.                                                       |
| `tools-local`: timeout de 2,5 s       | Retorno com erro de sintaxe antes do timeout esperado.                                                                                                |
| `tools-local`: `timeout:null`         | stdout vazio por falha do wrapper, esperado `ok`.                                                                                                     |
| `tools-local`: truncamento de streams | 0 caracteres por falha do wrapper, esperado 50.000 em cada stream.                                                                                    |
| `tools-security-lifecycle`: permissão | `stat.mode & 0o777` observado 438 (`0o666`), esperado 384 (`0o600`); a asserção é POSIX e não demonstra ACL Windows.                                  |

O aviso `realOrResolved: ... unresolved (ELOOP)` veio do caso de symlink
cíclico do teste; não foi uma falha adicional na suíte.
