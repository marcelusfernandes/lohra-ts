# T15 workflow executor evidence

The bilateral runner compares normalized candidate/oracle engine projections and
then crosses the real `ConversationRuntime` → `run_workflow` dispatcher using the
T02 loopback HTTP stub. It owns the exact mkdir lock
`/tmp/lohra-parity-11434.lock`, waits up to 15 minutes for a foreign owner, never
removes a foreign lock, and releases only the lock it acquired in `finally`.

```sh
npm run build
npx tsx scripts/parity/workflow-executor/run-all.ts
```

The engine projection covers success and a meaningful failure for all ten node
types, plus dynamic fanout rejection, soft token overrun, strict null upstream,
engine-fault isolation, schema retry, cache hit/invalidation, and nested depth.
The chat manifest records two real HTTP POSTs, tool args/results, normalized
requests, completed workflow output, faults/counters/token split, and stub
assertions.

Mutation evidence must run from a committed, clean candidate SHA. The runner
archives that SHA into a fresh temporary directory, symlinks only the existing
dependency tree, proves baseline green, executes every semantic mutant, restores
the archived sources between mutants, proves the final restore green, and removes
only its own temporary directory.

```sh
npx tsx scripts/parity/workflow-executor/run-mutations.ts
```

Generated records live under ignored `.parity-evidence/t15/`:

- `run-all.json` — bilateral engine + chat summary and lock protocol
- `t15-chat-workflow.json` — full parity-harness record
- `mutations.json` — baseline → each mutant red → restore result
