# Reproduzir #821

Use clones independentes do mesmo SHA para Node 20 e 22. Execute `npm ci`
separadamente para cada ABI, com `HOME`, `USERPROFILE`, `LOHRA_HOME`,
`CODEX_HOME`, `TEMP`, `TMP`, `npm_config_cache` e `npm_config_prefix`
temporários, fora do checkout. O vermelho `835bf0b` já contém o teste e a
declaração de prova compiláveis, sem a correção em `src/commands/chat.ts`:

```text
node node_modules/vitest/vitest.mjs run tests/chat-doctrine-preflight.test.ts --maxWorkers=1
```

No Windows, observe a rejeição `LOHRA_DOCTRINE` seguida de `EBUSY` na
limpeza de `state.db`; no Linux, observe a falha da assertion de ausência do
banco. O teste usa provider com URL loopback que não recebe request. Depois
aplique o código `0afe2e7` e execute:

```text
node node_modules/vitest/vitest.mjs run tests/chat-doctrine-preflight.test.ts tests/chat-doctrine-tier.test.ts --maxWorkers=1
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run prova -- chat-doctrine-preflight
```

No Linux, rode também `npm test -- --maxWorkers=1` como usuário não
privilegiado, o controle negativo e a fatia de mutação de contexto aplicável:

```text
npm run ci:controle-negativo -- --base 6cf57f3dbe9a67ce790e5aa3b82d7db44ea8a380 --head 0afe2e7f8b80f9db3d201118019234acace958e6 --branch fix/821-chat-doctrine-preflight
npm run mutations:t23
```

O dogfooding deve usar `node dist/cli.js chat --json`
**compilado neste worktree**, com provider real autorizado e `read_file` do
arquivo alterado, sem exibir credenciais. Não use um provider real para
reproduzir o vermelho.
