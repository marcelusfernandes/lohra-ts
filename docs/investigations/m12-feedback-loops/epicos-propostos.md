# Propostas de épicos para a M12 e o experimento de uso real

Anexo de [`../m12-feedback-loops.md`](../m12-feedback-loops.md) (issue #574).

> **Tudo neste arquivo é proposta.** Nenhuma issue foi criada, nenhum épico foi
> aberto, nenhum vínculo de sub-issue existe no GitHub — abrir os épicos antes
> de produzir a proposta é explicitamente "Fora de escopo" da #574. A ordem das
> seções é a ordem de execução sugerida; as duas primeiras são **conserto nas
> fundações de M8**, não trabalho novo de M12.

## Panorama e sequência proposta

| #   | Proposta                                                 | Classe          | Depende de                          | Gate para começar               |
| --- | -------------------------------------------------------- | --------------- | ----------------------------------- | ------------------------------- |
| 1   | Recusa de rota classificada por forma, não só por status | **fundação M8** | nada                                | nenhum — menor primeiro passo   |
| 2   | `acked_at` legível depois do ack                         | **fundação M8** | nada                                | nenhum                          |
| 3   | Medir o uso das superfícies de aviso                     | **M12, novo**   | 1                                   | nenhum                          |
| 4   | Escopo mecânico por tarefa de subagente                  | **M12, novo**   | contraprova de `taxonomia.md` § 4.3 | resultado da contraprova        |
| 5   | Candidato a insight estruturado                          | **M12, novo**   | 1, 3                                | resultado do experimento de § 6 |

As propostas 1 e 2 poderiam entrar como issues avulsas de M8 **sem** esperar
a abertura da M12 — nenhuma delas depende de qualquer decisão de aprendizado.

---

## 1. Proposta (fundação M8) — recusa de rota classificada por forma, não só por status

### Problema

Uma recusa real de modelo pelo provedor chega com HTTP 400 e o texto num
campo de topo do corpo; `classifyProviderError` exige 404 **e** um indício de
modelo em quatro lugares que não incluem esse campo (`taxonomia.md` § 2). O
sinal cai em `unknown`, e com isso deixa de acionar a pausa, a lição
estruturada e o aviso durável que #426 já entregou e que funcionam ao vivo
(`evidencias.md` § 2.3).

### User Story

**Como** operador que roda workflows em mais de um provedor,
**quero** que uma recusa de modelo seja reconhecida pela forma do erro, não só
pelo status HTTP,
**para que** o run pause com uma lição acionável em vez de falhar com uma
falha genérica que exige diagnóstico manual.

### Acceptance Criteria propostos

- [ ] O corpo de E1 (400 com o texto num campo de topo) classifica no kind que
      a decisão escolher — e a decisão entre "`model_not_found`" e "um kind
      novo" está registrada numa nota de decisão datada, com o motivo.
- [ ] Contraprova 1: 400 genérico sem indício de modelo continua `unknown`
      (`tests/transport-error-kinds.test.ts:128` segue verde sem edição).
- [ ] Contraprova 2: 400 malformado com `error.type: "invalid_request_error"`
      e `error.param` continua `unknown`.
- [ ] Não-regressão: 404 na forma OpenAI continua `model_not_found`; 404 sem
      indício de modelo continua fora do caminho de rota.
- [ ] Um run cuja folha recebe o corpo de E1 pausa com
      `pause_reason: route_fault`, lição estruturada e **um** aviso durável
      escopado a `run:<runId>` — provado num run durável de verdade, não com
      o classificador isolado.
- [ ] A lição permite distinguir "este modelo não existe" de "esta rota de
      autenticação não pode usar este modelo" (nem que seja registrando que a
      distinção foi considerada e adiada, com o motivo).

### Dependências

Nenhuma. Não depende da M12 nem da abertura de qualquer épico.

### Fronteiras (o que esta issue não faz)

- Não generaliza todo HTTP 400 como falha de rota.
- Não muda a política `metadata_only` da auditoria — a causa já está
  preservada em três camadas (`m12-feedback-loops.md` § 2.3).
- Não introduz pivô automático de rota: a decisão 4 do épico #421 continua
  valendo.
- Não acrescenta estado novo nem migração de schema.

### Primeiro experimento

Já executado e disponível: `e1-a8b2fb1c/classificador-sonda.json`. A issue
começa transformando aquelas sete linhas em casos de teste, com as duas
contraprovas primeiro (vermelho por comportamento, não por compilação).

### Adiados

A escolha entre acrescentar um 11º `ErrorKind` e enriquecer a proveniência de
`model_not_found` (`taxonomia.md` § 3, saídas (i) e (ii)) — decisão de design
com custo de migração, merece nota de decisão própria.

### Encaminhamento explícito de E1

**E1 é conserto de fundação M8, não trabalho novo de M12.** O tratamento de
uma recusa de rota — pausa, lição, aviso durável, resume com outra rota — já
existe, já está testado e foi **observado ao vivo** no HEAD (E1b). O que falta
é um predicado de classificação. Colocar isso dentro da M12 confundiria "a
fundação tem um buraco" com "precisamos de uma capacidade de aprendizado".

---

## 2. Proposta (fundação M8) — `acked_at` legível depois do ack

### Problema

Um aviso reconhecido volta com `acked_by` preenchido e `acked_at: 0` nas duas
superfícies de leitura (`evidencias.md` § 5). A causa é uma assimetria de
leitura: `created_at` usa `Number(...)`, `acked_at` passa por `rowNumber`, que
zera qualquer valor que não seja `Number.isSafeInteger` — e a coluna é `REAL`,
escrita com `Date.now() / 1_000`.

### User Story

**Como** operador que reconcilia avisos entre processos,
**quero** saber **quando** cada aviso foi reconhecido,
**para que** eu possa distinguir um aviso tratado ontem de um tratado agora — e
para que qualquer política de invalidação por idade tenha em que se apoiar.

### Acceptance Criteria propostos

- [ ] Depois de um `ack`, `acked_at` volta com o instante do ack (mesma
      unidade e precisão de `created_at`), lido de outro processo.
- [ ] `acked_at` continua `null` para um aviso não reconhecido.
- [ ] Mutante que reintroduza a truncagem é morto pela suíte.
- [ ] A correção não muda a forma de `created_at` nem de `fence`.

### Dependências

Nenhuma.

### Fronteiras

Não é ocasião para mudar o schema de `operator_notices`, a retenção LRU, nem o
formato do timestamp em disco.

### Primeiro experimento

Reproduzir com o controle 4 do script de E2 (ack em outro processo) e assertar
`acked_at > created_at` em vez de `acked_at === 0`.

### Adiados

Auditar se a mesma truncagem afeta outras colunas `REAL` lidas por
`rowNumber` — levantamento separado, não parte desta correção.

---

## 3. Proposta (M12) — medir o uso das superfícies de aviso antes de construir qualquer coisa

### Problema

A M12 existe para "aprendizado operacional", mas não há nenhuma medida de que
os incidentes se repitam em uso real, nem de que as superfícies existentes
(`workflow_notices`, auditoria, memória explícita) sejam subutilizadas. A
estatística do Python ("2 registros em 32 bancos") **não mede este runtime**,
e as sondas desta investigação repetem porque foram mandadas repetir.

### User Story

**Como** mantenedor decidindo o escopo da M12,
**quero** uma medida de recorrência e de uso das superfícies existentes em
tarefas reais,
**para que** a decisão de construir (ou não) uma camada de insight seja
tomada sobre dado, e não sobre a intuição de que faria falta.

### Acceptance Criteria propostos

- [ ] Um relatório sobre ≥ N sessões reais registra, por sessão: avisos
      criados por `kind`; avisos repetidos pela tripla provedor/modelo/kind;
      quantas vezes o agente chamou `workflow_notices` sem ter sido mandado;
      quantas vezes escreveu em `memory`.
- [ ] O relatório distingue incidentes **provocados** (sondas, testes) de
      incidentes **espontâneos**; nenhum número agregado mistura os dois.
- [ ] O relatório declara explicitamente o que **não** mede.
- [ ] A conclusão é uma das duas, por escrito: "a recorrência justifica a
      camada" ou "não justifica" — e a segunda fecha a proposta 5 como
      `wontfix`, sem desconforto.

### Dependências

Proposta 1 (sem ela, uma classe inteira de recusa nem aparece nos números).

### Fronteiras

Não altera comportamento do runtime; é instrumentação e leitura. Nada de
telemetria remota: os dados já estão no SQLite local.

### Primeiro experimento

§ 6 deste arquivo.

### Adiados

Ranking, esquecimento e promoção automática de memória — a issue não os
menciona nem como opção, por decisão da própria #574.

---

## 4. Proposta (M12) — escopo mecânico por tarefa de subagente

### Problema

No caminho de `delegate_task`, o escopo de uma tarefa é texto: nada impede
mecanicamente o filho de tocar um arquivo que a tarefa excluiu
(`evidencias.md` § 3, controle 6). No caminho de folha de workflow existe um
sandbox por policy, mas **o quanto ele já cobre esse caso não foi medido**.

### User Story

**Como** operador delegando uma tarefa estreita,
**quero** que o escopo declarado tenha efeito mecânico onde isso é possível,
**para que** "leia somente A" seja uma restrição verificável e não uma
sugestão ao modelo.

### Acceptance Criteria propostos

- [ ] A contraprova de `taxonomia.md` § 4.3 está executada e registrada: A
      permitido e B negado na folha de workflow; A e B nos dois caminhos, com
      o resultado de cada um.
- [ ] Se a folha de workflow **já** nega B: a issue vira "estender o mesmo
      mecanismo a `delegate_task`", com o mesmo vocabulário de recusa
      (`sandbox_denied`) e sem contrato novo.
- [ ] Se a folha de workflow **não** nega B: a issue vira "o mecanismo não
      cobre o caso", e um contrato por tarefa passa a ser discutível — com o
      custo declarado.
- [ ] Em qualquer dos dois ramos, o escopo textual continua sendo texto: a
      entrega **não** promete detectar desvio semântico do objetivo, e diz
      isso explicitamente.

### Dependências

A contraprova. Este épico não deve ser aberto antes dela: o resultado muda a
forma do trabalho.

### Fronteiras

- Não amplia permissões de ferramenta de ninguém (é o oposto do trabalho).
- Não trata desvio semântico (`taxonomia.md` § 4.2).
- Não trata o controle simulado como taxa de desvio de LLM nem como falha
  comprovada do sandbox.

### Primeiro experimento

A contraprova de `taxonomia.md` § 4.3, com resultado esperado declarado
**antes** da execução.

### Adiados

Contrato por tarefa formalizado (esquema, verificação, recusa) — só faz
sentido no segundo ramo.

---

## 5. Proposta (M12, condicionada) — candidato a insight estruturado

### Problema

Se a recorrência medida na proposta 3 for real, incidentes idênticos
continuam custando uma chamada ao provedor cada, e nada liga um ao outro.

### User Story

**Como** agente que já viu esta rota recusar,
**quero** consultar uma observação com escopo e proveniência antes de tentar
de novo,
**para que** a segunda tentativa idêntica não custe outra chamada.

### Acceptance Criteria propostos

- [ ] Cada candidato carrega os cinco eixos de proveniência de
      `m12-feedback-loops.md` § 4.2 — incluindo a **rota de autenticação**,
      sem a qual E1 generaliza errado.
- [ ] Cada candidato tem escopo explícito e uma condição de invalidação; um
      candidato sem invalidação não é aceito.
- [ ] O teto de candidatos por escopo é declarado **antes** da implementação
      (invariante 3).
- [ ] A escrita cross-process usa o mesmo mecanismo de lease/fence de
      `operator_notices` (invariante 4), não um segundo esquema.
- [ ] Nada entra no prompt vivo: um candidato só alcança um agente como
      conteúdo de turno ou como campo de tarefa no spawn (invariante 1).
- [ ] Existe uma contraprova de **não-generalização**: um candidato derivado
      de uma recusa específica de conta **não** é aplicado a outra rota.

### Dependências

Propostas 1 e 3. **Gate de entrada: o relatório da proposta 3 concluir que a
recorrência justifica** (§ 6).

### Fronteiras

- Nenhuma aplicação automática: um candidato informa, nunca decide rota ou
  cobrança (coerente com a decisão 4 do épico #421 e com o "Fora de escopo" da
  #574).
- Sem esquecimento, ranking ou promoção automática de memória.

### Primeiro experimento

Antes de qualquer schema: reproduzir E2 controle 3 com um candidato
**simulado** injetado à mão e medir se a segunda chamada some. Se não sumir,
o problema não era falta de armazenamento.

### Adiados

Tudo o que a #574 lista em "Fora de escopo", e que não deve ser reaberto por
consequência automática de uma lição: ampliação de permissões, mudança de
política de cobrança/rota, paridade com o Python.

---

## 6. Experimento de uso real

### 6.1 O que a sonda desta investigação **não** é

A sonda com modelo inexistente foi provocada: uma vez por controle, com um
modelo deliberadamente inválido, num ambiente construído para falhar.
**Ela não é frequência de falha em produção** e nenhum número desta
investigação pode ser lido assim. O mesmo vale para a repetição do controle 3,
que foi pedida explicitamente ao simulador.

### 6.2 Desenho proposto

| Item                                      | Valor proposto                                                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unidade de observação**                 | uma sessão de `chat` real, com tarefa de trabalho de verdade (não sonda)                                                                                                                                                                |
| **Baseline**                              | as sessões atuais, sem nenhuma mudança de comportamento: a contagem de avisos por `kind`, de repetições por `(kind, provider, model)` e de chamadas espontâneas a `workflow_notices` **antes** de qualquer intervenção                  |
| **Intervenção**                           | nenhuma na primeira fase. A primeira fase é puramente observacional — é isso que a torna barata e honesta                                                                                                                               |
| **Observação esperada** (declarada antes) | a hipótese de trabalho é **recorrência baixa**: < 1 incidente repetido por `(kind, provider, model)` a cada 20 sessões. Se for isso, a proposta 5 é fechada. Se for materialmente maior, a proposta 5 abre com o número medido no corpo |
| **Critério de parada**                    | o que vier primeiro: 30 sessões reais, ou o teto de custo abaixo                                                                                                                                                                        |
| **Teto de custo**                         | ver § 6.3                                                                                                                                                                                                                               |

### 6.3 Teto de custo, com a suposição citada

Não há dado de custo de produção; o teto é **derivado de uma suposição
declarada**, não inventado.

**Ancoragem medida** (E1b, `e1-a8b2fb1c/e1b-rota-anthropic.envelope.json`,
**observado ao vivo**): uma sessão de três tool calls consumiu
`api_calls: 4`, `usage_total.input_tokens: 87868`,
`usage_total.output_tokens: 961`.

**Suposição:** uma sessão de trabalho real é da mesma ordem de grandeza, com
margem de 3×, ou seja ≈ 2,6×10⁵ tokens de entrada e ≈ 3×10³ de saída por
sessão.

**Teto proposto:** o experimento para em **30 sessões observadas** ou ao
atingir **10⁷ tokens de entrada acumulados**, o que vier primeiro — e o
número real é reportado junto com o resultado, substituindo a suposição.

**Por que a margem de 3× e não outra:** é a menor margem que cobre uma sessão
com contexto compactado uma vez; qualquer número menor arriscaria parar o
experimento antes da amostra. Isto é um julgamento declarado, não uma medida.

### 6.4 O que o experimento não vai medir

- Desvio semântico de subagente (não há forma de aceitação — `taxonomia.md`
  § 4.2).
- Utilidade de uma camada de insight que ainda não existe: o experimento mede
  a **necessidade**, nunca o benefício de algo não construído.
- Comportamento sob provedor de assinatura, enquanto a rota não estiver
  disponível na máquina de observação (`evidencias.md` § 2.1).
