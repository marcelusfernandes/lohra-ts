---
name: use-lohra-ts
description: TRIGGER — delegate substantial, self-contained project work to lohra-ts (the TypeScript agent runtime in this repository, not the Python `lohra`) via its CLI, or resume/inspect one of its durable `run_workflow` runs. Do NOT load for a single tool call you can do yourself, for `delegate_task`, or when the user only asked what lohra-ts or a workflow is.
---

# Delegate work to lohra-ts

lohra-ts is an independent, tool-using CLI agent — this repository's own
runtime, not the Python `lohra`. Give it the outcome and the boundaries; let
it choose the tools, the implementation, and the validation steps.

## Name collision, resolved before the first call

Both runtimes install a binary literally named `lohra` (this package's
`package.json` declares `"bin": {"lohra": "dist/cli.js"}`) — whichever one a
`PATH` resolves first answers to that name. Run `lohra doctor --json` before
delegating: the profile, model catalog and error text it reports are
lohra-ts's own. If a machine keeps both runtimes installed, resolve the
collision with an explicit path or a dedicated shell alias — a `--profile`
only changes which config the SAME binary reads, never which binary runs.

## Run the delegation

1. Work from the root of the target project so lohra-ts can read its
   `AGENTS.md`/`CLAUDE.md`, its memory, and its project skills.
2. Formulate a task with only the non-negotiable context:
   - the desired outcome;
   - the allowed scope (especially for code changes);
   - what counts as done.
3. Invoke in structured, tool-enabled mode:

   ```bash
   lohra chat --profile "ts-<project>" --no-input --json "<task>"
   ```

   `--no-input` is the headless guarantee: under `--json` lohra-ts already
   never reads stdin or prompts, and this flag turns any remaining
   confirmation into a fast failure instead of a hang. A dedicated
   `--profile` keeps this project's sessions, memory and skills isolated
   from any other `lohra chat` run on the same machine.

4. Add `--yolo` only when the user has explicitly authorized lohra-ts to run
   commands and edit files without interactive approval. Without it, a
   recognized dangerous command (a recursive delete, a raw write to a block
   device, a permission change to world-writable, a fork bomb, piping a
   download into a shell, a destructive SQL statement, …) is auto-denied and
   surfaces as that tool call's own error — it never hangs waiting for a
   human under `--json`. Never infer that authority from a request to merely
   analyze or recommend.

5. `--model`/`--provider` override this run's routing; leave them unset to
   use the profile's own configuration. `--max-parallel` caps how many tool
   calls lohra-ts runs at once (default 4). `--max-iterations` raises the
   agent-loop ceiling above its default of 90 — raise it, not any timeout,
   if a long task dies with `max_iterations (N) reached`: that error counts
   tool-call rounds, not wall-clock time.

## Verify the delegation

Treat a run as successful only when all of these hold:

- the CLI exits with code `0`;
- the JSON envelope has `error: null`;
- for a task that inspects, implements, tests, or researches project state,
  at least one `tool_calls` entry is present — a zero-tool response is not
  project-specific evidence, even when the prose reads like one.

Independently inspect the changed files and re-run the relevant validation
before presenting delegated work as complete. Include the `session_id`,
the tools used, and the validation result in the handoff.

## Continue a useful session

Reuse the returned `session_id` only when a follow-up turn genuinely needs
the same lohra-ts context:

```bash
lohra chat --profile "ts-<project>" --no-input --json --session "<session_id>" \
  "Address the failed test and rerun the focused validation."
```

Start a fresh session for an unrelated task.

## Long-running work: workflows

A delegated task may start a `run_workflow` — a durable DAG of sub-agents
that survives the CLI process, persisted to disk. These four subcommands
only read that durable state; none of them call a model:

```bash
lohra workflow list
lohra workflow watch <run_id> --events
lohra workflow audit <run_id>
lohra workflow notices --all
```

`list`/`watch` show why a run paused (`checkpoint`, `token_budget_exhausted`,
`route_fault`, …). A paused run resumes through a normal prompt — same
session if it still has context, or a fresh `lohra chat --profile
"ts-<project>" --no-input --json "resume run <run_id>"` otherwise — never
through a `workflow` subcommand: those only inspect, they cannot resume.
Resuming replays only the nodes that had not finished; already-completed
work is never re-run.

## Minimal user-facing request

The user should be able to say:

> Use lohra-ts to inspect this project and implement the safest high-value
> reliability improvement. Keep changes scoped to the project and validate
> the result.

Do not require the user to name tools, flags, files, or an implementation
plan unless those details genuinely define the intended outcome.
