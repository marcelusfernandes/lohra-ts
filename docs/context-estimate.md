# Estimador de tokens do histórico

`estimateTokens(messages)` (`src/context/token-estimate.ts`, issue #251,
sub-issue do épico #230 — "Janela de contexto: compactar antes de estourar")
estima quantos tokens de input um histórico de mensagens vai consumir, sem
chamar o provedor e sem embutir um tokenizer real. É o insumo que a próxima
sub-issue (compactação preflight) usa para decidir se compacta antes de
chamar o modelo — hoje o runtime só descobre o estouro pela resposta do
provedor (`finish_reason: length` ou erro de janela).

## Por que heurística e não um tokenizer real

- Cada provedor tokeniza diferente (BPE do OpenAI, o tokenizer da Anthropic,
  etc.) e nenhum dos dois é público como pacote leve sem rede. Embutir um
  tokenizer específico amarraria o estimador a um provedor e ainda erraria
  para os outros.
- O contrato pede zero chamada de rede e zero dependência nova
  (`package.json` é proibido nesta issue).
- A meta não é exatidão — é nunca subestimar. Uma estimativa conservadora
  que dispara compactação um pouco cedo é barata; uma que deixa o turno
  estourar a janela não é.

## Método

Para cada mensagem do array, soma:

1. **Overhead fixo por mensagem** (`MESSAGE_OVERHEAD_TOKENS = 6`) — cobre a
   formatação de role/delimitadores que todo provedor adiciona por entrada.
2. **Conteúdo** (`message.content`):
   - String: `chars / 2.9` (texto solto — prosa de usuário/assistente),
     exceto quando `role === "tool"`, que usa o fator denso (2.4) porque
     resultado de tool tende a ser JSON.
   - Array de blocos (formato Anthropic-style: `text`, `thinking`,
     `tool_result`, `tool_use`, ou qualquer bloco futuro desconhecido):
     cada bloco é medido pelo tipo; um tipo não reconhecido nunca é
     ignorado — cai no fallback conservador (`JSON.stringify` do bloco
     inteiro, fator denso).
3. **`tool_calls`** — para cada chamada, `(nome + argumentos) / 2.4` mais
   `TOOL_CALL_OVERHEAD_TOKENS = 4` (envelope `type`/`function`/`id`).
4. **Raciocínio** — `message.reasoning` (string, formato usado ao persistir
   turnos) e `message.provider_data.thinking_blocks[].thinking` (formato de
   replay da Anthropic), cada um com o fator denso (2.4). As duas fontes
   nunca duplicam a mesma informação dentro de uma mensagem, então são
   somadas, não escolhidas.
5. **`name`** — nome de função/tool anexado à mensagem, fator de texto.

Dois fatores de caracteres-por-token:

| Fator                  | Valor | Para quê                                                      |
| ---------------------- | ----- | ------------------------------------------------------------- |
| `TEXT_CHARS_PER_TOKEN` | 2.9   | Prosa solta (texto de usuário/assistente)                     |
| `JSON_CHARS_PER_TOKEN` | 2.4   | JSON de tool call/tool result, raciocínio, bloco desconhecido |

JSON e raciocínio tokenizam com menos caracteres por token do que prosa
(pontuação, chaves, aspas, palavras curtas repetidas) — por isso o fator
denso é menor que o de texto, o que aumenta a estimativa para esse
conteúdo (mais conservador).

## Calibração contra `usage` real

As constantes acima foram ajustadas contra duas chamadas reais de provedor
(nunca simuladas), capturadas com `AnthropicMessagesTransport`/
`ChatCompletionsTransport` + os clients de `src/transports/client.ts`,
usando a mesma conversa (system prompt, pergunta do usuário, um tool call
com argumentos JSON, o resultado do tool e uma pergunta de acompanhamento)
contra dois provedores diferentes. As fixtures — mensagens e `usage`
reportado — estão em `tests/fixtures/context/`:

| Fixture                     | Provedor / modelo                 | `usage.inputTokens` real | Estimativa | Erro relativo |
| --------------------------- | --------------------------------- | ------------------------ | ---------- | ------------- |
| `openrouter-tool-call.json` | OpenRouter / `openai/gpt-4o-mini` | 311                      | 472        | 1.52×         |
| `anthropic-tool-call.json`  | Anthropic / `claude-haiku-4-5`    | 441                      | 472        | 1.07×         |

A mesma conversa gera contagens reais bem diferentes entre os dois
provedores (Anthropic tokeniza tool call/tool result de forma mais densa
que o Chat Completions do OpenRouter) — por isso calibrar contra dois
provedores, e não um só, importa: um fator ajustado só para o OpenRouter
teria ficado abaixo do real da Anthropic.

`tests/context-estimate.test.ts` prende os dois lados do contrato sobre
toda fixture em `tests/fixtures/context/`: a estimativa nunca fica abaixo
de `usage.inputTokens`, e a razão `estimate / real` nunca passa de 2× (teto
para não ser absurdamente conservadora). O teste também exige pelo menos
duas fixtures de provedores distintos no diretório — remover uma delas sem
repor quebra a prova.

## Limitação conhecida

O bloco `thinking` (raciocínio nativo da Anthropic) e o fator de raciocínio
em geral não têm fixture real dedicada — nenhuma das duas chamadas
capturadas usou extended thinking. O fator denso (`JSON_CHARS_PER_TOKEN`) é
aplicado a raciocínio por cautela (mesmo tratamento que JSON, e não o fator
de texto solto, mais permissivo), mas não foi medido contra `usage` real
com raciocínio. Uma fixture com `reasoning`/`thinking_blocks` populado é o
próximo passo natural se a estimativa se mostrar imprecisa nesse caso em
produção.

## Fora do escopo desta issue

- Resolver a janela efetiva do modelo (sub-issue anterior do épico).
- Decidir _quando_ compactar a partir da estimativa (issue #252: compactação
  preflight sob trava, com latch anti-fútil — `docs/context-compaction.md`).
  `estimateRequestTokens` (a mesma issue, mesmo arquivo) é quem soma o
  prompt de sistema e as definições de tool a esta estimativa antes de
  comparar contra a janela — esta função aqui nunca vê os dois.
- Qualquer chamada de rede ou tokenizer externo.
