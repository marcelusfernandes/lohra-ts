# ADR 0004: Autonomous work — the orchestrator merges when the gates are mechanical

- Status: Accepted by owner
- Date: 2026-09-05
- Baseline: `4b73f09` (`main` after PR #30, the first merge performed under this
  model)
- Supersedes: the "the person reviews and decides the merge" and "no push before
  the person confirms" rules of `.claude/rules/git-workflow.md` as written in
  #23
- Tracking: milestone "Trabalho autônomo" — #31 (this ADR), #32 (protection of
  `main`), #33 (proof by slug), #34 (negative control and scope in CI), #35
  (agents), #36 (hook bench)
- Reference: `tacit-wl/apollo`, `.docs/decisoes/0012-trabalho-autonomo.md`,
  adapted; differences are listed at the end

## Context

Until 2026-09-04 integration into `main` was driven by an external tool
(Traycer): one branch per ticket, an evaluator scoring an "approved head", an
explicit merge commit and a provenance table in `docs/closeout.md`. That tool
is gone (#14). The first replacement rule, written in #23, copied Marvinz's
"the AI never merges — the person reviews and decides". The Apollo repository
studied Marvinz and discarded exactly that rule as a textual gate that blocks
nothing: in practice pull requests were merged within minutes without a human
review. Its replacement is a merge conditioned on facts a machine can check.

PR #30 was merged under that replacement before this ADR existed: CI green on
the exact head, a read-only reviewer agent returned `rejected`, the
implementer fixed every item, the reviewer returned `approved`, the
orchestrator applied `review:approved` and merged. The reviewer caught a real
error (a document entering the repository asserting the premise the same PR
revoked) and a fail-closed violation in a script. This ADR records the model
that already worked.

## Decision

Implementation is done by agents without a human in the loop, with humans at
the explicitly listed gates below and nowhere else.

1. **Unit of work is an issue** written in the repository's section standard
   (`.claude/skills/issue/references/template.md`), with verifiable
   Acceptance Criteria, a `Proof` naming `npm run prova <slug>` (#33) and a
   `Files` list of globs it may touch (#34). The orchestrator writes issues as
   the planner; an issue too large for one session becomes an epic with
   sub-issues linked natively.
2. **Claiming an issue is pushing its remote branch** `<type>/<n>-<slug>`,
   created with `gh issue develop <n> --base main`. The push fails if the
   branch already exists — that failure is the lock. `<n>` ties branch,
   issue and proof slug together.
3. **One worktree per issue** for any agent that writes. `git rebase
origin/main` only before the first push; after the branch is published,
   conflicts are resolved with `git merge origin/main` on the branch. Never a
   force-push, on any branch.
4. **The orchestrator merges, mechanically conditioned.** A PR is merged when
   every required CI check is green on the PR head **and** the read-only
   reviewer applied `review:approved`. Nothing else is required — not a
   human comment, not "the branch is up to date" (CI runs again on `main`
   after every merge and is the net). The merge is a **merge commit**, never a
   squash: `scripts/provenance/check-ancestry.ts` verifies that approved heads
   are ancestors of `main`, and a squash would rewrite the branch out of the
   history it protects. `gh pr merge --admin` is never used.
5. **Two rejected rounds escalate.** After the second `rejected` (CI or
   reviewer) the orchestrator labels the issue `state:blocked` and `human`,
   comments the reasons, and moves on to another issue. It does not keep
   iterating.
6. **Parallelism is bounded by scope.** Up to four issues in flight whose
   `Files` globs do not intersect. Until #34 lands the `escopo` check, the
   orchestrator checks intersection by hand and keeps it at one or two.
7. **PR classes.** `feature`/`fix`/`refactor`/`test`: CI + reviewer. `docs`:
   CI only, no reviewer. `chore`/`ci` touching `.claude/`, `.github/`,
   `package.json` or the lockfile: only the orchestrator opens them, CI +
   reviewer.
8. **Reconciliation before work.** At the start of a session the orchestrator
   re-reads GitHub — open PRs, `state:*` labels, linked branches — and never
   trusts its memory. An `in-progress` issue with no open PR and no recent
   commits goes back to `state:ready`; a PR with CI green and
   `review:approved` is merged; a local worktree whose remote branch is gone
   is removed.
9. **Human gates, exhaustively:** accepting an ADR (explicit OK; silence is not
   approval); any secret, credential or environment variable; the ruleset and
   branch protection of `main`; publishing the package to a registry; any
   issue in `state:blocked`; deleting branches or rewriting history. Everything
   else — planning, implementation, review, merge — runs without a human.
10. **Trunk is `main`.** No `develop`. If a second long-lived branch is ever
    introduced, the `Closes #N` auto-close no longer fires and a
    `close-linked-issues` workflow becomes necessary.
11. **Dogfooding before push** stays a gate of the implementer: a real run of
    the runtime (Codex and/or OpenRouter, a task that uses a tool) with exit
    0, `error: null` and `tool_calls` recorded in the PR test plan (owner rule
    of 2026-09-05, already in `git-workflow.md`).

## Cost accepted

No human reviews a pull request in the normal path. Quality depends on the
required checks being blocking in fact (#32 ruleset), on the reviewer agent
being adversarial and read-only (#35), and on negative control being verified
by CI rather than declared (#34). Until #32 lands, `gh pr merge` is not
mechanically blocked on this machine — the rule is text, and the owner knows
it.

## Differences from Apollo's ADR 0012

- **Merge commit instead of squash**, for the provenance invariant above.
- **Public repository**: a real ruleset on `main` is available and is one of
  the four protection layers in #32; Apollo, on a free private plan, had to
  rely on hooks plus a detector.
- **Language**: Portuguese everywhere except the ADR series, as the rest of
  this repository.
- **No `banco`, `operador`, `explorador`** — Supabase, deploy and legacy-app
  roles that do not exist here. `qa` gains mutation testing (#13).
- **`git stash` is not denied**: the owner's global rules prescribe stashing
  before destructive operations.

## Evidence required to retain this decision

- Every merge into `main` is a merge commit whose parents include a PR head
  with `review:approved` and green required checks — checkable with
  `gh api repos/{owner}/{repo}/commits/{sha}/pulls` and the labels of that PR.
- `scripts/provenance/check-ancestry.ts` stays green on `main`.
- At least one issue reaches `state:blocked` with the two rejections recorded
  as reviewer comments, proving the escalation path exists and is used.
- `.claude/rules/orquestracao.md` describes the loop that sessions actually
  run; a drift between the two is a defect of this ADR.

## Revisit triggers

Reopen this ADR before any of the following:

- adopting squash merges or any history rewrite on `main`;
- adding a second long-lived branch;
- letting any agent other than the orchestrator run `gh pr merge`;
- removing `review:approved` or a required check from the merge condition;
- a merged PR later shown to have had a reviewer verdict that was not
  adversarial (rubber stamp) — the reviewer prompt becomes the defect.
