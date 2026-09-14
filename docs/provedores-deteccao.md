# Detecção de provedor: `doctor` × `chat`/`dashboard`

Contrato entre `lohra doctor` e `chat`/`dashboard` sem `--provider` na rota
`api_key` (sem assinatura ativa) — issues #604 e #631. `doctor` é só leitura;
este documento existe para que ele nunca prometa um comportamento que o
`chat` não cumpre.

## Os três campos

| Campo                                     | O que responde                                                                                   | Fonte                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `usable`                                  | "existe algum jeito de rodar?" — chave de API, Ollama vivo (`ollama.alive`) ou assinatura ativa. | `src/doctor/snapshot.ts` (`hasApiKey \|\| ollama.alive \|\| subscription…`)                                                         |
| `detected_provider`                       | "qual provedor uma chave de API/`LOHRA_PROVIDER` configura?"                                     | `detectConfiguredProvider` (`src/doctor/providers.ts`)                                                                              |
| `chat_default_provider` (#631, rota #633) | "qual provedor `chat`/`dashboard` de fato usam sem `--provider`, nesta rota de auth?"            | `src/doctor/snapshot.ts`, sobre o mesmo `route` que `chat.ts:157-163,184,230` consulta (docblock completo em `src/doctor/model.ts`) |

`detected_provider` responde só pela rota `api_key` (`detectConfiguredProvider`,
sem olhar `route`). `chat_default_provider` responde pelo que `chat` de fato
faria em **qualquer** rota — na rota `api_key` sem erro, mesma regra de
`detected_provider` (`detectChatProvider`, mesma tabela por baixo, então os
dois concordam ali); em `route.error`, é `null` mesmo com uma chave presente
(`chat` cai na fronteira sem olhar nenhuma); em `route.mode === "subscription"`,
é o nome fixo da rota de assinatura (`CODEX_PROVIDER.name`,
`"openai-codex"`), nunca o de uma chave de API. `usable` é mais larga que
qualquer um dos dois (conta Ollama e assinatura), e um consumidor de
`doctor --json` que só olhasse `usable` não tinha como saber que
"utilizável" não significava "`chat` vai rodar sem flags".

## A tabela de contrato

| Estado do ambiente                                     | `usable` | `detected_provider` | `chat_default_provider` | `chat` sem `--provider`                          |
| ------------------------------------------------------ | :------: | :-----------------: | :---------------------: | ------------------------------------------------ |
| Chave de API configurada (rota `api_key`, sem erro)    |   true   |    `"anthropic"`    |      `"anthropic"`      | roda (issue #604)                                |
| Só Ollama vivo, sem chave                              |   true   |       `null`        |         `null`          | cai na fronteira "no provider configured" (#631) |
| Nada configurado                                       |  false   |       `null`        |         `null`          | cai na fronteira "no provider configured"        |
| Assinatura ativa (`route.mode === "subscription"`)     |   true   |    (não olhado)     |    `"openai-codex"`     | roda via Codex, mesmo com chave no `.env` (#633) |
| `route.error` (ex.: `preference=subscription` inativa) | depende  |    (não olhado)     |         `null`          | cai na fronteira (#633)                          |

A linha "só Ollama vivo" é o que a issue #631 fecha: antes dela, o relatório
humano do `doctor` imprimia `[ok] provider ollama (from keyless: ...)` sem
avisar que essa leitura não se traduz em `chat` funcionando sem flag. Dois
testes de contrato pinam a tabela inteira, com asserção cruzada real entre os
dois comandos no mesmo ambiente:
`tests/cli-doctor.test.ts` (`describe("doctor × chat, só Ollama vivo (issue
#631)")` e o `describe("doctor × chat contract (issue #604)")` acima dele) e
`tests/chat-provider-detectado.test.ts`.

## Por que `chat` não passa a considerar Ollama (Opção A rejeitada)

A issue #631 levantou duas opções: (A) `detectChatProvider` também probar
Ollama quando nenhuma chave está presente, ou (B) `doctor` só reportar
explicitamente o que já é verdade. A escolhida foi **B**:

- (A) acrescentaria ~500 ms de latência (o timeout do probe HTTP) a **toda**
  invocação de `chat`/`dashboard` sem chave configurada, mesmo em CI ou numa
  máquina sem Ollama instalado.
- (A) tornaria o AC2 de #604 ("home vazio ⇒ fronteira", pinado byte a byte em
  `tests/chat-provider-detectado.test.ts`) intermitente em qualquer máquina
  de desenvolvedor com `ollama serve` rodando em segundo plano.

Com (B), `chat`/`dashboard` continuam sem tocar a rede do Ollama quando não
há `--provider` — só `doctor` (que já probava Ollama antes desta issue) e o
próprio `ollama serve`, se o operador seguir a instrução do Check, tocam essa
porta.

## O Check `ollama-sem-chave`

Emitido por `runChecks` (`src/doctor/checks.ts`) só quando as três condições
valem ao mesmo tempo: `auth_route === "api_key"`, `isOllamaReady(ollama)`
(issue #633: a mesma função de prontidão que `providerCheck` usa — Ollama
vivo **e** com pelo menos um modelo puxado, não só `ollama.alive`) e
`chat_default_provider === null`. Estado `warn` (não `fail`: `usable` já é
`true`, e o exit code do `doctor` não muda por esta issue). Abaixo, a saída
literal de `renderChecks` (`checks.ts:297`) para esse Check — uma linha de
detalhe, uma de remédio, sem quebra interna (pino:
`tests/doctor-checks-ollama.test.ts`):

```
[warn] ollama-sem-chave      usable é true só pelo Ollama (keyless) -- chat/dashboard sem --provider ainda caem em 'no provider configured'
                             → lohra chat --provider ollama   # ou: export LOHRA_PROVIDER=ollama
```

Fora dessas três condições — Ollama vivo mas sem nenhum modelo puxado (aí
`providerCheck` já reporta `fail` sozinho; recomendar `--provider ollama`
falharia por falta de modelo), rota `subscription` (onde `chat_default_provider`
é o nome da rota de assinatura, nunca `null` — issue #633) ou
`auth_route === "unusable"` (onde `chat` cai na fronteira mesmo com
`--provider` explícito, então a instrução não ajudaria) — o Check não
aparece.
