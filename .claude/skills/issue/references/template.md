# Padrão de corpo de issue

Seções fixas, nesta ordem. Nenhuma é pulada; se genuinamente não se aplica,
escreva "N/A" e uma frase explicando.

```markdown
> **Tamanho:** <S | M | L> — <escopo em poucas palavras>
> **Parent / Sub-issues:** <#N (vínculo nativo) | nenhuma>

## User Story

**Como** <persona real do sistema — mantenedor, contribuidor, operador, revisor>,
**quero** <capacidade>,
**para que** <benefício>.

---

## Contexto

<background técnico/negócio; cite arquivo:linha reais>

## Cenário atual

<o que acontece hoje, com precisão; trechos curtos de código quando ajudar>

## Problema

<numerado quando houver mais de um; o GAP entre atual e desejável; sem solução aqui>

## Consequências do problema

<bullets: impacto concreto — UX, risco técnico, custo, segurança, dívida>

---

## O que é a solução

<pode ter ### 1. ### 2. …; contratos, módulos, testes; trade-offs quando houver>

## Resultado esperado com a solução

<bullets "depois disto, X acontece e Y deixa de acontecer" — verificáveis>

---

## Acceptance Criteria

- [ ] <5 a 10 itens objetivamente verificáveis>
- [ ] Testes (unit / integration / e2e conforme aplicável)
- [ ] Documentação atualizada (quando aplicável)

## Fora de escopo

- <o que fica explicitamente de fora>

## Referências

- <arquivo:linha>
- <issues, ADRs, docs>
```

## Régua de Tamanho (agentes, não dias humanos)

- **S** — 1 sessão curta: fix cirúrgico em 1-2 arquivos, ou refactor mecânico.
- **M** — 1 sessão média: cross-layer simples, ou refactor com decisões.
- **L** — múltiplas sessões ou squad com gates humanos. Se for L, considere
  virar épico com sub-issues.

## Regras de qualidade

- User Story na voz do usuário do sistema, não do dev.
- Cenário atual ≠ Problema: um descreve, o outro é o gap.
- Solução não vai dentro do Problema.
- Citações concretas > prosa; toda `arquivo:linha` precisa existir.
- Acceptance Criteria testáveis: "X passa a retornar Y quando Z", não "melhorar X".
