---
name: issue
description: Cria uma issue do lohra-ts no GitHub já completa — corpo no padrão de seções, milestone, labels de tipo e complexidade, e vínculo nativo de sub-issue quando há um épico pai. Use quando o usuário pedir "cria uma issue", "abre issue", "registra isso como issue", "sub-issue de #N", ou quando a regra issue-first exigir tracking antes de começar trabalho. NÃO use para editar issues existentes nem para abrir PR (skill `pr`).
argument-hint: '<descrição do problema> [--parent N] [--milestone "título"]'
allowed-tools: Bash, Read, Grep, Glob, Write
user-invocable: true
---

# /issue — issue completa, de uma vez

Produz a issue pronta para o board: corpo no padrão fixo de seções, milestone,
labels e — se houver épico pai — vínculo **nativo** de sub-issue (a API
`sub_issues`, não texto).

## Passos

1. **Capturar contexto.** Se o pedido cita arquivos ou símbolos, abra-os e
   cite `arquivo:linha` reais. Nunca invente referência. Uma ou duas perguntas
   só se houver ambiguidade séria sobre o objetivo.
2. **Título** em Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`,
   `chore:`, `refactor:`, `ci:`, `perf:`), < 80 chars, PT-BR.
3. **Tamanho** S/M/L pela régua de `references/template.md` (sessão de agente,
   nunca dias humanos). Vira o header `> **Tamanho:**` **e** a label
   `complexity:S|M|L` — o script deriva a label do header; os dois nunca
   divergem.
4. **Labels de tipo**: `bug`, `enhancement`, `documentation`, `epic`,
   `investigation`. Opcionalmente `independence:I1|I2|I3`. `severity:*` só
   vem de review independente — não atribuir ao criar.
5. **Milestone**: o do épico pai, se houver; senão o que o usuário indicou;
   senão perguntar. `gh api repos/{owner}/{repo}/milestones` lista os abertos.
6. **Corpo** em `references/template.md`, todas as seções na ordem, nenhuma
   pulada ("N/A" + uma frase quando não se aplica). Escrever num arquivo
   temporário.
7. **Criar** com o script (ele valida as seções, deriva `complexity:*`, cria,
   liga ao pai e imprime a URL):

   ```bash
   .claude/skills/issue/scripts/create-issue.sh \
     --title "<título>" --body-file /tmp/issue.md \
     --milestone "<título do milestone>" --labels enhancement \
     [--parent <N>] [--dry-run]
   ```

8. **Reportar** a URL e, em 3-4 bullets, título, labels, milestone, pai.

## Regras

- Padrão de seções é fixo; o script recusa corpo sem alguma delas.
- `Tamanho` no header e `complexity:*` são a mesma informação — nunca setar a
  label à mão.
- Sub-issue é sempre nativa (`--parent`). "Parent / Sub-issues" no header é
  informativo; o vínculo real é a API.
- Não cria branch, commit nem PR. Para PR, skill `pr`.
- Idioma PT-BR, como o resto do repositório.
