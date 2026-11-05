---
name: workflow-flow-control
description: Make a dynamic workflow take a different road, or repeat a step, depending on the run's state. Covers the `switch` node — pick one of 2 to 16 cases by the value of a field and run only that case's leaf, with an `otherwise` and a `null` case that runs nothing — and the `loop` node — repeat a body until a mechanical predicate on its output holds (a score reaches a threshold, a list reaches a size), with a mandatory `max_rounds` cap of 1 to 16. Load it after `workflow-authoring` when the next step depends on a value (reuse an answer vs investigate, stop early vs continue) or when a result has to be refined until it passes a check. Do NOT load for a straight-line workflow where every node always runs, for a fan-out over a list (`parallel`, `pipeline`), for a human sign-off (`checkpoint`), or for "keep going until a round finds nothing new" (`loop_until_dry`).
version: 1.1.0
---

# Flow control in dynamic workflows

A workflow runs every node of its graph, in dependency order. That is the right
default, and it is wasteful when the answer to an early question makes the later
work pointless: "we already solved this", "the input is out of scope", "this one
needs a person". `switch` is the block that lets a spec take a different road
**without** a different graph: the roads live inside one node, and only the one
that matches the state runs. `loop` is the opposite need: the graph is right, but
one step has to be repeated until its result passes a check, and nobody knows in
advance how many passes that takes.

Read `workflow-authoring` first for node choice, sizing and refs. This skill only
adds the control-flow blocks.

---

## 1. `switch` — one case, chosen by a value

Reach for it when **what to do next depends on a value an earlier node produced**,
and the paths cost different amounts. The classic shape is a cheap classifier
followed by a `switch` whose expensive cases only run when they are needed:

```json
{
  "meta": { "name": "triage" },
  "schemas": {
    "KIND": {
      "type": "object",
      "properties": { "kind": { "enum": ["reuse", "investigate", "escalate"] } },
      "required": ["kind"]
    }
  },
  "nodes": [
    {
      "id": "classify",
      "type": "agent",
      "prompt": "Is this question already answered, in need of digging, or a job for a person? ${args.question}",
      "schema_ref": "KIND"
    },
    {
      "id": "route",
      "type": "switch",
      "value": "${classify.kind}",
      "cases": {
        "reuse": null,
        "investigate": { "prompt": "Investigate ${args.question} and report the cause." },
        "escalate": { "prompt": "Write the escalation note for ${args.question}." }
      },
      "otherwise": "investigate"
    }
  ]
}
```

### The fields

| Field                                 | What it is                                                                                                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`                               | Exactly **one** `${ref}` — the field the switch reads (`${classify.kind}`, `${args.mode}`). No text around it, no expression. It reads what a prompt would render, so a JSON string and an array index are traversed (`${scan.labels.0}`), and an absent field is `null`.  |
| `cases`                               | A mapping of **2 to 16 cases**. Each case is either `null` (a branch that runs nothing) or an agent-shaped object with a `prompt`, plus optionally `schema`/`schema_ref`, `tool_less`, `timeout`, `retries` and `max_iterations` — the same knobs a `gate`'s `body` takes. |
| `otherwise`                           | Optional. Names one of the cases; it runs when `value` matches none. Without it, a value that matches nothing is a fault.                                                                                                                                                  |
| `model`, `tier`, `effort`, `provider` | The routing knobs go **on the node**, and every case inherits them. Inside a case they are refused at validation as an unknown field — a case cannot route differently from its siblings.                                                                                  |

`required` and `depends_on` work as on any node. The switch also waits for every
node a `${ref}` in **any** case prompt reads, whether or not that case is the one
chosen — the graph is built from the whole node.

### How a value picks a case

- A **string**, a finite **number** or a **boolean** names a case by its string form:
  `"investigate"` matches the case `investigate`, `2` matches `"2"`, `true` matches
  `"true"`. The match is exact and case-sensitive.
- `null`, a missing field, a list or an object matches **nothing**. Nothing is ever
  coerced: the list `["investigate"]` is not the case `investigate`.
- An inherited name such as `constructor` is not a case.

The value is only as good as the node that produced it. Give the classifier a
`schema` with an `enum` of exactly the case names, and the switch never sees a
word it does not know. That is far cheaper than relying on `otherwise`.

### What it returns

`{case, matched, output}`:

- `case` — the name of the case that ran.
- `matched` — `true` when the value named it, `false` when `otherwise` caught the value.
- `output` — that case's leaf output (the parsed object when the case has a schema), or
  `null` for a `null` case.

Downstream nodes read the pieces: `${route.case}`, `${route.matched}`, `${route.output}`.
A prompt that reads `${route.output}` fails with `upstream null` when a `null` case was
taken, because there is nothing to read. Read `${route.case}` instead, or only read
`output` in nodes that every case feeds.

### What runs, and what it costs

- **Exactly one leaf** runs, for the chosen case, with the role `switch.case` and an
  `item_index` equal to the case's position in `cases` (the first is 0, in object key
  order, which puts integer-looking names first). `workflow_audit` shows that one `leaf.started` and
  nothing for the other cases.
- The cases **not chosen do not exist at run time**: no spawn, no cache cell, no event,
  and their prompts are never resolved — a `${ref}` that would be `null` there does not
  matter.
- A **`null` case** runs nothing at all: no leaf, no cell, no budget spent. The node
  still returns `{case, matched, output: null}` and counts as complete — it is the way
  to say "stop here" or "reuse what we have".
- The one leaf goes through the same budget gate as any leaf: a run at its fan-out or
  lifetime cap trips there, with the cap in `faults`.

### When it fails — never silently

| What happened                                           | What you see                                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No case matches and there is no `otherwise`             | The node is `null` and `faults` has `<id>: no case matches <value> and the switch has no otherwise`. The names in `cases` and the values the classifier produces do not agree; fix one of them, or add an `otherwise`. |
| The node that `value` reads failed (its root is `null`) | `<id>: upstream null`, and nothing runs. This is a dead upstream, **not** a missing field: a node that returned but lacks the field is a value that matches nothing, and `otherwise` catches that.                     |
| The chosen case's prompt reads a `null`                 | `<id>: upstream null`; no leaf spawns.                                                                                                                                                                                 |
| The chosen case's leaf dies                             | The node is `null` and `faults` carries the leaf's cause. The case's own `retries` (0 to 3) respawn a dead leaf before giving up.                                                                                      |
| The chosen case answers with an empty output            | `<id>: case <name> returned an empty output`, and the empty answer is not cached.                                                                                                                                      |

### Resume and cache

The cell is the chosen case, its rendered prompt, its schema, the routing and the
case's knobs. A resume **re-reads `value`**:

- the same case → the cell is replayed, no spawn;
- a different case → that case runs, and the ledger says `cache.missed` with
  `reason: identity_changed`, because the node already has a cell under another identity;
- a different value that lands on the **same** case through `otherwise` → replayed too,
  with `matched: false`;
- changing the chosen case's prompt, schema or knobs is a different cell, as for any node.

`workflow_preview` reports a switch as `replay` or `recompute` like any node, `no_leaves`
when it took a `null` case (nothing to replay, nothing to pay), and `upstream_missing`
when the value it reads belongs to a node that would have to run again.

### Patterns

- **Reuse or work.** A classifier with an `enum` schema, then a `switch` whose `reuse`
  case is `null`. The expensive cases only exist when the classifier asks for them.
- **Stop early.** A `null` case for "nothing to do", and later nodes that read
  `${route.case}` to say so. A `switch` does not skip nodes of the graph — every later
  node still runs — so a node that must not run on the stop path has to be written to
  cope with it (or live inside the case's prompt).
- **Two decisions.** Chain two `switch` nodes: the second reads a field of the first's
  `output`. There is no `and`/`or` and no nested `switch`.

### What it is not

- Not a loop (that is `loop`, below) and not a fan-out: one value, one leaf. Fan out with
  `parallel` or `pipeline`.
- A case body is agent-shaped. It cannot hold a `workflow`, a `checkpoint` or another
  `switch`; put those in their own nodes.
- No expressions: `value` is a single `${ref}`. Compute the value in an `agent` with a
  schema, then switch on its field.

---

## 2. `loop` — repeat a body until a condition holds

Reach for it when a result has to be **refined until it passes a check** and the number of
passes is not known up front: "rewrite until the clarity score reaches 8", "extend the list
until it has ten entries", "retry the extraction until the `valid` flag is true". The body is
one agent-shaped leaf per round; after each round a **mechanical predicate** (no model call)
decides whether to stop.

```json
{
  "meta": { "name": "refine-until-clear" },
  "schemas": {
    "DRAFT": {
      "type": "object",
      "properties": { "text": { "type": "string" }, "score": { "type": "number" } },
      "required": ["text", "score"]
    }
  },
  "nodes": [
    {
      "id": "refine",
      "type": "loop",
      "body": {
        "prompt": "Rewrite the text to be clearer. This is round ${round}; earlier attempts: ${so_far}. Original: ${args.text}. Answer with the new text and a score from 0 to 10 for how clear it is.",
        "schema_ref": "DRAFT"
      },
      "until": { "gte": { "path": "${last.score}", "n": 8 } },
      "max_rounds": 4
    },
    {
      "id": "report",
      "type": "agent",
      "prompt": "Present the final text and say whether the bar was met: ${refine.last.text} (rounds: ${refine.rounds}, met: ${refine.until_met})"
    }
  ]
}
```

### The fields

| Field                                 | What it is                                                                                                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body`                                | An agent-shaped object with a `prompt`, plus optionally `schema`/`schema_ref`, `tool_less`, `timeout`, `retries` and `max_iterations` — the same body a `gate` takes. Each round renders the prompt again, so it can read `${round}` and `${so_far}`. |
| `until`                               | A predicate (the table below). It is evaluated after every round, and the loop stops at the first round where it holds.                                                                                                                               |
| `max_rounds`                          | A whole number, **1 to 16 rounds**. There is no default and no "unlimited": a loop without it is refused at validation.                                                                                                                               |
| `model`, `tier`, `effort`, `provider` | The routing knobs go **on the node**, and every round inherits them. Inside `body` they are refused, as in a `gate`.                                                                                                                                  |

`max_rounds` is required, and it is a **cap checked up front**: the whole cap is measured
against the run's fan-out limit and its remaining lifetime before round 0 starts, even if
`until` holds on round 0. A `max_rounds` the run cannot afford is rejected at once, naming
the limit, and nothing is spawned; the leaves themselves are only paid for as rounds run.
Size it for the worst case you can stand, not for the average.

### The locals

| Local       | Where it is readable   | What it is                                                                                 |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `${round}`  | `body.prompt`, `until` | The round that is running, counting from 0.                                                |
| `${so_far}` | `body.prompt`, `until` | The list of the outputs of the rounds **before** this one, oldest first (`[]` on round 0). |
| `${last}`   | `until` only           | The output of the round that just ran. It is the thing the predicate tests.                |

`last` exists only inside `until`: anywhere else it is refused at validation as an unknown
node. If a node of your own is called `last`, that node stays reachable from outside
`until`, but a spec that reads `${last}` inside `until` while also having a node called
`last` is refused — rename the node. Every other `${ref}` works as usual in the body and in
`until`: `${args.x}` and the outputs of upstream nodes (`${scan.threshold}`).

`${so_far}` grows by one output per round and is rendered into every later prompt. Give
the body a `schema` so each output stays small, and think twice before a high `max_rounds`
with large free-text outputs.

### The predicates

An `until` is an object with exactly **one key**, the predicate's name; its value holds the
fields. `path` is exactly one `${ref}` — no text around it, no expression — and it reads what
a prompt would render (a JSON string and an array index are traversed, `${last.items.0}`,
and an absent field is `null`). Operands (`value`, `values`, `n`, `type`) are **literals**:
no `${}` inside them.

| Predicate      | Fields                                                                      | Holds when                                      |
| -------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| `field_equals` | `path`, `value` (a string, number, boolean or null)                         | the field is exactly `value` (`===`)            |
| `field_true`   | `path`                                                                      | the field is `true`                             |
| `in`           | `path`, `values` (a list of 1 to 64 scalars)                                | the field is a scalar and is one of `values`    |
| `gte`          | `path`, `n` (a finite number)                                               | the field is a finite number and `>= n`         |
| `lt`           | `path`, `n` (a finite number)                                               | the field is a finite number and `< n`          |
| `count_gte`    | `path`, `n` (a whole number, 0 or more)                                     | the field is a list with at least `n` items     |
| `empty`        | `path`                                                                      | the field is `null`, absent, `""`, `[]` or `{}` |
| `field_type`   | `path`, `type` (`number`, `string`, `boolean`, `array`, `object` or `null`) | the field has that JSON type                    |
| `not`          | `of` (any predicate except another `not`)                                   | the inner predicate does not hold               |

There is no `and`/`or`: to need two conditions, encode both in one field of the body's
schema (a `ready` boolean the body computes) and test that. A comparison against a field
that is missing or of the wrong type simply does not hold — it never throws, so a body that
forgets the field runs to the cap, and the cap fault says so.

### What it returns

`{last, rounds, until_met}`:

- `last` — the output of the final round.
- `rounds` — how many rounds ran (1 when `until` held on round 0).
- `until_met` — `until_met: true` when `until` held, `until_met: false` when the cap stopped
  the loop.

Downstream nodes read the pieces: `${refine.last.score}`, `${refine.rounds}`,
`${refine.until_met}`. When `until_met` is `false` the node is **not** `null`: `last` is the
best the loop produced and a later node can still use it, but the run ends `degraded` and
`faults` carries `<id>: reached max_rounds (<n>) without 'until' holding`. Check
`${refine.until_met}` in the node that consumes it if "not good enough" must be handled.

### What runs, and what it costs

- **One leaf per round**, with the role `loop.round` and the round number as its `attempt`
  (the first is 0). `workflow_audit` shows one `leaf.started` per round that ran, and none
  for rounds after `until` held.
- The body's `retries` (0 to 3) respawn a dead leaf **inside** the round; they do not
  consume a round.
- Progress is `items {done, total}` with `total = max_rounds`, reported at the start and after
  every round, so `workflow_status` shows how far the loop is.
- It is **sequential**: round `r + 1` needs round `r`'s output. Nothing else in the node runs
  in parallel.

### When it fails — never silently

| What happened                                         | What you see                                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `until` never held in `max_rounds` rounds             | The node returns `{last, rounds, until_met: false}`, `faults` has `<id>: reached max_rounds (<n>) without 'until' holding`, and the run ends `degraded`.                    |
| A round's leaf died                                   | The node is `null` and `faults` has `<id>: round <n> dead` next to the leaf's own cause. No later round runs. The rounds already finished stay cached.                      |
| A round answered with an empty output                 | `<id>: round <n> returned an empty output`; the node is `null` and the empty answer is not cached.                                                                          |
| A node that `until` reads failed (its root is `null`) | `<id>: upstream null` **before round 0** — no leaf is spent testing a condition that cannot hold. A root that is there but lacks the field is only a value, not this fault. |
| The body prompt reads a `null`                        | `<id>: upstream null`; the round does not spawn.                                                                                                                            |
| The cap cannot be afforded                            | The fan-out or lifetime limit is named in `faults` and counted as a cap trip; the node is `null` and nothing was spawned.                                                   |
| The run is paused or cancelled mid-loop               | The node is `null` with **no fault of its own** — the pause or cancel already recorded its cause. A resume picks up where it stopped.                                       |

### Resume and cache

The loop keeps **one cell per round**: the round number, its rendered prompt (which carries
`${so_far}`), the body's schema and knobs, and the routing. A resume re-runs the node and
**continues from the round it stopped at**:

- rounds `0..k-1` that already finished are replayed with `cache.replayed` and **no spawn**;
  round `k` is the first to run;
- `until` and `max_rounds` are **not** part of a cell, so a resume may tighten the `until` or
  raise the cap and still reuse every round already paid for — the loop just goes on from
  the replayed rounds;
- changing the body (prompt, schema, knobs) or the routing changes the cells, so the rounds
  run again;
- in the ledger a round that runs after earlier ones were stored shows `cache.missed` with
  `reason: identity_changed`, and `workflow_preview` reports a loop that has some rounds
  stored and some still to run as `recompute`: the node already holds other cells, which is
  all those words mean here.

### Patterns

- **Refine to a bar.** The body writes a draft and a self-assessment in a `schema`
  (`{text, score}`); `until` is `{gte: {path: "${last.score}", n: 8}}`. A score the body
  gives itself is only as honest as the model — when an independent reviewer matters, use a
  `gate` instead (a separate reviewer leaf, up to 3 attempts).
- **Fill a quota.** The body adds items to a list; `until` is
  `{count_gte: {path: "${last.items}", n: 10}}`.
- **Retry until valid.** The body extracts structured data and reports `valid`; `until` is
  `{field_true: {path: "${last.valid}"}}`, with a small `max_rounds`.
- **Stop on a signal from upstream.** `until` may read a node that ran before the loop
  (`{field_true: {path: "${scan.ready}"}}`) — useful with `not`.

### What it is not

- Not `loop_until_dry`. That node stops when **k rounds in a row bring nothing new** and
  returns the list of everything found; use it to exhaust a source. `loop` stops on a **value
  in the output** and returns `{last, rounds, until_met}`.
- Not a retry of one leaf: for a leaf that may die use the body's `retries`.
- Not a place for a `workflow`, a `checkpoint`, a `switch` or another `loop` inside the body:
  the body is agent-shaped. Put those in their own nodes.
- No expressions and no `and`/`or` in `until`; `max_rounds` is a literal, never a `${ref}`.

---

## 3. Checklist before calling `run_workflow` with flow control

For a `switch`:

1. Is `value` exactly one `${ref}`, to a field whose possible values I know?
2. Does the node producing it have a `schema` with an `enum` of the case names?
3. Is there an `otherwise` — or am I happy for an unexpected value to be a fault?
4. Which case should run nothing? Make it `null`, not an agent that says "nothing to do".
5. Do later nodes read `${route.output}` where a `null` case would leave them with `upstream null`?
6. Are the routing knobs on the node, not inside a case?

For a `loop`:

1. Is the condition something a predicate can test on one field of the output? If not, compute
   that field in the body's `schema`.
2. Is `max_rounds` the worst case I can afford (1 to 16)? It is checked against the run's limits up
   front.
3. Does the body prompt use `${round}` or `${so_far}` so each round builds on the last, instead
   of repeating the same request?
4. Is `${last}` used only inside `until`?
5. Does the node after the loop check `${refine.until_met}` if a loop that hit the cap must be
   treated differently from one that passed?
6. Are the routing knobs on the node, not inside `body`?
