# Janela efetiva de contexto

Como o runtime decide "quantos tokens cabem nesta chamada" quando não há
metadado explícito vindo do provedor — pré-requisito da compactação (milestone
"Janela de contexto: compactar antes de estourar", issue #250, sub-issue do
épico #230). Este documento descreve a precedência hoje; a estimativa de
tokens do histórico (#251) e a compactação de verdade (#252) são issues
separadas que consomem esta resolução, ainda não fiadas a ela.

## A função

`resolveContextWindow` (`src/providers/context-window.ts`) é pura — recebe
tudo pronto, nenhuma I/O dentro dela — e devolve `{ tokens, source }`:
`source` sempre diz qual nível decidiu, nunca um número "no escuro".

```ts
resolveContextWindow({
  provider: "openai",
  model: "gpt-4o-mini-2024-07-18",
  override, // number | null | undefined
  catalog, // ContextWindowCatalog | null | undefined
  profile, // ProviderProfile
});
// => { tokens: 128000, source: "table" }
```

## Precedência (do mais para o menos específico)

1. **`override`** — config explícita, hoje só `LOHRA_CONTEXT_WINDOW`
   (`src/config/context-window-env.ts`). Um valor inválido (não inteiro, `<=
0`, string com lixo) nunca cai silenciosamente para o próximo nível: lança
   `LOHRA_CONTEXT_WINDOW_INVALID:<valor bruto>` na leitura da variável, e a
   própria `resolveContextWindow` lança `CONTEXT_WINDOW_INVALID_OVERRIDE:<valor>`
   se receber um `override` numérico fora do domínio (não inteiro ou `<= 0`)
   — a validação nunca é opcional, mesmo chamando a função pura direto.
2. **`catalog`** — o cache do catálogo do provedor (`loadWindowsCache`,
   issue #249, `src/catalog/windows-cache.ts`), por modelo exato. Um modelo
   ausente do cache ou com janela `null` (provedor não relatou) cai para o
   próximo nível.
3. **`table`** — `ProviderProfile.modelWindows`
   (`src/providers/registry.ts`), por **prefixo mais longo** do id do
   modelo: um id datado como `gpt-4o-mini-2024-07-18` casa com a entrada
   `gpt-4o-mini`, não com `gpt-4o`, porque `gpt-4o-mini` é o prefixo mais
   longo presente na tabela que ainda é prefixo do id. Depois do prefixo
   casado, só um separador (`-`, `.`, `:`, `/`, `@`) ou o fim do id fecha o
   casamento — mesma regra de `priceKey`/`lookup` em
   `src/pricing/estimate.ts:48-51` — então `gpt-4` nunca casa com um futuro
   `gpt-45`. Uma entrada com valor inválido (não inteiro, `<= 0`) nunca
   vence, mesmo sendo o prefixo mais longo.
4. **`provider`** — `ProviderProfile.defaultContextWindow`, o piso do
   provedor, usado quando o modelo não está em nenhuma tabela.
5. **`default`** — `200000`, quando nada acima resolveu (provedor sem piso
   configurado, como `ollama`, onde a janela real depende do modelo local
   que a pessoa escolheu rodar).

## A tabela estática (`src/providers/registry.ts`)

Pequena e datada de propósito: só os modelos que este runtime usa hoje
(`fallbackModels` e `defaultAuxModel` de cada perfil,
`src/providers/registry.ts:1-317`), cada linha com um comentário `// fonte:
<url>, 2026-09`. Nunca inventada — um modelo sem fonte verificável fica fora
da tabela e cai no piso do provedor (nível 4) ou no default global (nível 5),
nunca num número chutado.

Modelos com nome de versão futura e sem fonte pública verificável hoje
(`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `grok-4.6`,
`grok-4.3`, `glm-5.3`, `glm-5.3-flash`, `kimi-k3`, `kimi-k2.6`,
`deepseek-chat`, `deepseek-reasoner`) ficam **de fora** da tabela por esse
motivo. `gpt-5.5` é exceção: tem fonte verificada
(https://developers.openai.com/api/docs/models/gpt-5.5, 2026-09-10 —
"1,050,000 context window") e entra na tabela do perfil separado do Codex
(`CODEX_PROVIDER`, que resolve o caminho de subscription — não o mesmo
objeto do perfil `openai`, cujo `modelWindows` não lista `gpt-5.5` porque
esse perfil só serve `gpt-4o`/`gpt-4o-mini`). Anthropic, OpenAI e
`CODEX_PROVIDER` têm piso de provedor (`defaultContextWindow`): 200k para
Claude (padrão estável da família há várias gerações), 128k para OpenAI
(idem, família GPT-4) e **1.050.000 para `CODEX_PROVIDER`** — a mesma
janela de `gpt-5.5`, o único modelo da família GPT-5.x que esse perfil
serve hoje, não os "128,000 max output tokens" da mesma página (métrica
diferente de janela de contexto). Um modelo de subscription do Codex
futuro, ainda sem entrada na tabela, cai nesse piso — não no default
global de 200000. Os outros provedores sem piso caem direto no default de 200000.

## Override por config: `LOHRA_CONTEXT_WINDOW`

Lida por `resolveContextWindowOverride` (`src/config/context-window-env.ts`),
que não segue o padrão "inválido vira aviso e cai no default" de
`positiveIntEnv` (`src/orchestration/limits.ts`): aqui, um valor inválido é
sempre um erro nomeado (`LOHRA_CONTEXT_WINDOW_INVALID:<valor bruto>`) —
ausente ou em branco é o único caso que devolve `null` (nenhum override, sem
avisar nada, porque não configurar não é um erro).

## Fora de escopo desta issue

- Ninguém ainda chama `resolveContextWindow` do caminho de chat/aux — a
  fiação com o estimador de tokens (#251) e a compactação (#252) são issues
  separadas. **Atualização (#252):** a fiação aconteceu —
  `resolveTurnContextWindow` (`src/conversation/compaction.ts`) chama esta
  função a cada turno, dentro do preflight de compactação. Detalhes em
  `docs/context-compaction.md`.
- Modelos futuros sem fonte verificável (lista acima) não entram na tabela
  agora; entram quando houver uma fonte real a citar.
