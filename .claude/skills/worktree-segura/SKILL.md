---
name: worktree-segura
description: Como trabalhar num worktree isolado do lohra-ts sem perder trabalho nem quebrar o gate compartilhado — provas antes da primeira linha, git não destrutivo, checkpoint a cada verde, rodada 2 em branch nova, conflito com main por merge. Use no início de toda implementação em worktree (agentes `implementador`, `qa`, `documentador`) e sempre que um hook de Stop ou de escrita reclamar. NÃO use fora de worktree.
---

# Worktree segura

Adaptada do Apollo (`worktree-segura`), que a adaptou do Marvinz: quase toda
turbulência vem de vários escritores numa árvore só; isolar primeiro resolve a maioria.

## A. Antes da primeira linha

1. **`node_modules` existe?** Worktree nasce só com arquivos versionados.
   `.claude/settings.json` declara `worktree.symlinkDirectories: ["node_modules"]`, então o
   Claude Code linka o do checkout principal. Se `test -d node_modules` falhar, `npm ci`
   (compila `node-pty`; leva ~1 min).
2. **A base é a certa?** `git fetch origin && git merge-base --is-ancestor origin/main HEAD`.
   Se a issue depende de outra, `grep -rn "<símbolo do pré-requisito>" src` tem de achar —
   worktree velho não vê o que a outra issue entregou.
3. **Consigo escrever?** `printf x > .scratch && rm .scratch`. O hook `protege-escrita`
   reclama agora, não na terceira edição — e nega `docs/reference/` e `lohra/` sempre.
4. **Vai fazer dogfooding?** As chaves vivem em `~/.lohra/.env` (`LOHRA_HOME`), fora do
   repo — nada precisa ser copiado para o worktree. `lohra-ts doctor --json | jq .environment.usable`
   tem que ser `true`. O shim `lohra-ts` aponta para o `dist/` do checkout principal;
   para testar o código **deste** worktree, `node dist/cli.js` depois de `npm run build`
   aqui.

## B. Enquanto trabalha

5. **Nunca git destrutivo:** `reset --hard`, `checkout <arquivo>`, `clean` apagam trabalho
   não commitado (`stash` é permitido, mas só sobre o seu próprio trabalho). Para comparar
   use `git diff <ref>` e `git show <ref>:<path>`. Perdeu algo? `git reflog` primeiro.
6. **Checkpoint a cada verde.** Um teste que passou, um `tsc` limpo: commit. A única cópia
   do trabalho não commitado é a árvore.
7. **Teste vermelho compila.** Um teste que importa símbolo inexistente é erro de
   compilação e trava o Stop hook (`tsc --noEmit`). Exporte um stub que lança
   (`throw new Error("not implemented")`) e faça o vermelho ser de runtime. Commit como
   `test(red): …`.
8. **Confira com o comando exato do gate**, não com uma versão parcial: `npm run typecheck`,
   `npm run lint`, `npm run format:check`, `npm test` (e `npm run prova <slug>` quando #33
   existir). Um `tsc -p` parcial ou um `vitest` num arquivo só dá verde falso.
9. **Desconfie de erro velho.** O Stop pode reportar um estado que a última edição já
   corrigiu. Rode de novo antes de "consertar" o que já passou.

## C. Rodada 2 ou mais da mesma issue

Você nasceu num worktree novo; o da rodada anterior não é seu. Parta de `origin/<branch>`
(`git fetch origin && git checkout -b <branch>-rN origin/<branch>`), trabalhe, e no fim
`git push origin HEAD:<branch>` — fast-forward, nunca force (o hook e o `pre-push` negam).
Se o push não for fast-forward, alguém tocou a branch: `git merge origin/<branch>` e tente
de novo.

## D. Conflito com `main`

**Branch ainda não publicada:** `git fetch origin && git rebase origin/main`.
**Branch já publicada (PR aberta):** `git fetch origin && git merge origin/main`, resolva,
commit de merge, push normal. Rebase aqui exigiria push forçado, negado em qualquer
branch. O merge final é por merge commit (ADR 0004), então o histórico da branch fica
como está. Depois de resolver, rode os gates de novo antes de atualizar a PR.
