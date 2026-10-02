# Sondas nativas descartáveis — #703

SHA: `fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`. OS: Windows 11 x64.
Node: 20.20.2 e 22.23.3 x64. Os scripts `probe.mts`, `probe-policy.mts`,
`probe-shell.mts`, `probe-tree.mjs`, `parent.mjs` e `grandchild.mjs` foram
escritos somente em `%TEMP%\lohra-w703-probe-<id>`, fora do checkout. Imports
de `src/tools/*`/`src/workflow/sandbox.ts` saíram dos clones temporários
com o mesmo SHA; `tsx` e `node-pty` vieram dos respectivos `node_modules`.
Os logs brutos não foram incluídos porque contêm caminhos pessoais e sequências
de terminal. Os campos abaixo preservam valores necessários à conclusão.

Padrão de invocação para cada Node (o comando real usou caminhos absolutos
dos diretórios temporários indicados no relatório do #701):

```powershell
$env:LOHRA_SOURCE_ROOT = '<TEMP>\lohra-w701\clone-workaround[-22]'
$env:LOHRA_PROBE_ROOT = '<TEMP>\lohra-w703-probe-<id>\node20-final|node22-final'
& '<TEMP>\lohra-w701\node-v20.20.2-win-x64|node-v22.23.3-win-x64\node.exe' '<clone>\node_modules\tsx\dist\cli.mjs' '<TEMP>\lohra-w703-probe-<id>\probe.mts'
```

`probe.mts` chamou `writeFileTool({path,content})`,
`readFileTool({path})`, `readFileTool({path:path.replaceAll('\\','/')})`,
`terminalTool({command,cwd,timeout})`, `ApprovalManager` e `node-pty.spawn`
direto. Conteúdo: `linha α\r\nlinha β\nemoji 😀\r\n`. Comandos da tool:
`echo OUT & echo ERR 1>&2 & exit /b 7`, `cd`,
`ping -n 8 127.0.0.1 >nul` com timeout 0,5 s e `sudo echo forbidden`
para a recusa pré-execução. A sonda direta usou `cmd.exe /d /s /c echo
PTY-DIRECT`. **Exit 0** do harness em ambas as versões.

| Campo da saída                | Node 20                                                                                        | Node 22                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `file-unicode-space-eol`      | `writeOk=true`, `bytes=31`, `readOk=true`, `contentEqual=true`, `slashEqual=true`, `drive=C:\` | Igual                                      |
| `reserved-name`               | `aux.txt`: `ok=true`, `exists=true`                                                            | Igual                                      |
| `long-path`                   | comprimento 427, `writeOk=true`, `readEqual=true`                                              | Igual                                      |
| `symlink`                     | `created=true`, conteúdo igual, `untrusted=true`                                               | Igual                                      |
| `terminal-stdout-stderr-exit` | `ok=true`, `exitCode=1`, stdout vazio, `A sintaxe do nome do arquivo...`                       | Igual                                      |
| `terminal-cwd-space`          | `ok=true`, `exitCode=1`, stdout vazio, mesmo erro                                              | Igual                                      |
| `terminal-timeout`            | `error=command timed out after 0.5s`, sem exit code                                            | Igual                                      |
| `policy-denial`               | `refusal=final`, padrão `sudo`                                                                 | Igual                                      |
| `pty-direct`                  | PID 56196, `exitCode=0`, marcador presente                                                     | PID 49080, `exitCode=0`, marcador presente |

`probe-policy.mts` passou um `fake base` sem efeitos a `sandboxDispatch`,
com `workingRoot=<TEMP>\policyNN\working` e política vazia. **Exit 0**
em Node 20/22:

```text
read_file(working\inside.txt) -> ERROR: path is outside the workflow working scope
read_file(<TEMP>\outside.txt) -> ERROR: path is outside the workflow working scope
read_file(working) -> BASE:read_file
terminal('echo SAFE') -> BASE:terminal
web_fetch('http://127.0.0.1') -> ERROR: host is not in the workflow egress allowlist
web_search('safe') -> BASE:web_search
child terminal('sudo echo SAFE') -> refusal: final
```

`probe-shell.mts` executou `terminalTool` sob dois launchers externos,
PowerShell e `cmd /d /c` (script `.cmd` descartável, cwd ASCII com espaço).
Ambos os launchers terminaram o harness com **exit 0** e receberam da tool
`exitCode=1`, stdout vazio e o mesmo erro de sintaxe do `cmd.exe`. Para
controle, `cmd.exe /d /s /c` direto com `(echo OUT) 1>"<TEMP>\out.txt"
2>"<TEMP>\err.txt"` terminou com **exit 0** e gravou `OUT`.

`probe-tree.mjs` iniciou `parent.mjs` via `node-pty.spawn(node.exe, ...)`;
o pai criou `grandchild.mjs`. Antes de `pty.kill()`, ambos os PIDs respondiam
a `process.kill(pid,0)`. Um segundo depois, ambos não respondiam. A sonda
executou `taskkill /PID ... /F /T` apenas se um de seus próprios PIDs ainda
estivesse vivo e confirmou limpeza. **Exit 0** nos dois Nodes.

| Node    | PID PTY/pai | PID neto | Antes       | Após 1 s       | Limpeza        |
| ------- | ----------: | -------: | ----------- | -------------- | -------------- |
| 20.20.2 |       63584 |    58456 | ambos vivos | ambos ausentes | ambos ausentes |
| 22.23.3 |       36364 |    33844 | ambos vivos | ambos ausentes | ambos ausentes |

Essa árvore usou o addon diretamente. O wrapper do `terminalTool` não chegou
a iniciar `parent.mjs`, então esses PIDs não medem o comportamento de timeout
ou cancelamento da tool do produto.
