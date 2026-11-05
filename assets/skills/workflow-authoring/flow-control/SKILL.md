---
name: workflow-flow-control
description: Make a dynamic workflow take a different road, or repeat a step, depending on the run's state. Covers the `switch` node — pick one of 2 to 16 cases by the value of a field and run only that case's leaf, with an `otherwise` and a `null` case that runs nothing — and the `loop` node — repeat a body until a mechanical predicate on its output holds (a score reaches a threshold, a list reaches a size), with a mandatory `max_rounds` cap of 1 to 16 — and the `escalate` node — pause the run for a person only when a predicate holds, with a `kind` and a `summary`, answered through `checkpoint_answers` — and the `call` node — run `read_file` or `web_fetch` with no model, a `timeout` of up to 120 seconds and 0 to 3 `retries`, and read the result by `${node.field}`. Load it after `workflow-authoring` when the next step depends on a value (reuse an answer vs investigate, stop early vs continue), when a result has to be refined until it passes a check, when only the exceptional runs need a person, or when a step only has to read a file or fetch a page. Do NOT load for a straight-line workflow where every node always runs, for a fan-out over a list (`parallel`, `pipeline`), for a human sign-off that must always happen (`checkpoint`), or for "keep going until a round finds nothing new" (`loop_until_dry`).
version: 1.3.0
---

# Flow control in dynamic workflows

A workflow runs every node of its graph, in dependency order. That is the right
default, and it is wasteful when the answer to an early question makes the later
work pointless: "we already solved this", "the input is out of scope", "this one
needs a person". `switch` is the block that lets a spec take a different road
**without** a different graph: the roads live inside one node, and only the one
that matches the state runs. `loop` is the opposite need: the graph is right, but
one step has to be repeated until its result passes a check, and nobody knows in
advance how many passes that takes. `escalate` is for the third need: the run should
go on alone, and stop for a person only in the cases that call for one. `call` is the fourth, and
the cheapest: a step that only reads a file or fetches a page needs no model at all.

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

## 3. `escalate` — stop for a person only when a condition holds

Reach for it when **most runs should go on alone and only the exceptions need a person**: a
risk score over a bar, a loop that gave up, a classifier that is unsure. A `checkpoint` always
stops the run; an `escalate` stops it only when its `when` predicate holds, and tells the
reviewer why with a `kind` and a `summary`. Nothing in it calls a model: the condition is the
same mechanical predicate `loop` uses.

```json
{
  "meta": { "name": "release-gate" },
  "schemas": {
    "RISK": {
      "type": "object",
      "properties": { "risk": { "type": "number" }, "reason": { "type": "string" } },
      "required": ["risk", "reason"]
    }
  },
  "nodes": [
    {
      "id": "scan",
      "type": "agent",
      "prompt": "Rate the risk of shipping ${args.change} from 1 to 10 and say why.",
      "schema_ref": "RISK"
    },
    {
      "id": "review",
      "type": "escalate",
      "when": { "gte": { "path": "${scan.risk}", "n": 7 } },
      "kind": "high_risk",
      "summary": "Risk ${scan.risk} on ${args.change}: ${scan.reason}"
    },
    {
      "id": "ship",
      "type": "agent",
      "prompt": "Write the release note for ${args.change}.",
      "depends_on": ["review"]
    }
  ]
}
```

With a risk under 7 the run goes straight through. With 7 or more it stops at `review`, and
`ship` does not start until a person has answered.

### The fields

| Field     | What it is                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `when`    | A predicate from the table in section 2: it holds, or the run goes on. It reads the state like any `${ref}`. There is no `${last}` here, and no `and`/`or`: chain two nodes. |
| `kind`    | A short lowercase tag matching `^[a-z][a-z0-9_]{0,31}$` — the class of case, for the reviewer to sort by. It is never text and never a `${ref}`.                             |
| `summary` | The text a person reads: **1 to 2000 characters**, `${ref}`s allowed. The human reads the summary, not the run — put in it what is needed to decide.                         |

`required` and `depends_on` work as on any node. The node has **no routing knobs**
(`model`, `tier`, `effort`, `provider`): it spawns nothing, so there is nothing to route, and
they are refused as unknown fields. There is also no `default`: an escalation always waits for
a person.

### What it returns

- `when` does not hold: `{escalated: false}`. No leaf, no cell, no fault of its own; the run goes on.
- `when` holds and a person answered: `{escalated: true, kind, summary, answer}`. The answer can
  be any JSON value, `false` and `""` included.
- `when` holds and nobody has answered: the node is `null` and the run ends `paused`.
- `when` cannot be checked, or the `summary` cannot be written: it fails **closed** — the run
  ends `paused` as above, never past the node (see "When it fails").

A later node can read `${review.escalated}` and, once it is `true`, `${review.answer}`. A `switch`
on `${review.escalated}` is the clean way to use the answer only when there is one.

### The pause

The run ends with `status: paused` and a `reason` of `escalated` (`pause_reason` in a live
`workflow_status`). The reply carries the `escalation` field, `{node_id, kind, summary}`, and a
`hint`. In the ledger it is a `node.paused` event with `reason: "escalated"`, and
`lohra workflow list` shows `paused (escalated: <kind>)`.

Answer it through the same channel as a `checkpoint` —
`run_workflow(resume_run_id=..., checkpoint_answers={"<node_id>": <answer>})` — because `checkpoint`
and `escalate` are the two node types a person answers. Three things differ:

- **There is no default, and nothing resumes it on its own.** A resume without the answer is
  refused with an error that names the node and the summary, **before** it takes the run's lease:
  the run stays exactly as it was, and no leaf is spent.
- **Nodes after it wait.** The run stops at the node, so the ones that come later do not start.
  A node with no link to the escalate may already have run, so a node that must not run before a
  person has looked **`depends_on` the escalate**.
- **It does not notify.** The pause is visible in `workflow_status`, `lohra workflow` and the
  ledger; it posts no notice.

Inside a nested `workflow` node the id is scoped, as for a checkpoint: `<workflow node id>.<escalate id>`
(for example `sub.review`), and `node_id` in the reply already carries the form the answer
must use. The bare escalate id is accepted while nothing else owns it. When it collides — with a
`checkpoint` or an `escalate` at the root, or with a sibling nested `workflow` that uses the same
inner id — only the scoped key is accepted, and the bare one is refused and named instead of
answering the wrong node. If the scoped key is itself a root node's id, the reply carries
`rename_hint`: resuming with it only pauses again.

### When it fails — never silently

| What happened                                                                         | What you see                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A node that `when` reads failed (its root is `null`), or a root the run does not have | The condition cannot be checked, so it is **held to be true** and the run pauses `escalated`. The summary opens with `[condition not evaluated: '<node>' has no value]`, and `faults` has `<id>: upstream null` plus the pause fault, which names the node. A root that is there but lacks the field is only a value (`gte` on nothing does not hold): that is not this case. |
| The `summary` reads a value that is not there (a missing field, a `null`)             | The run pauses `escalated`. The summary goes out as the raw template behind `[unrendered]` — `[unrendered] Risk ${scan.risk}: ${scan.reason}` — and the pause fault names every `${ref}` with no value (`no value for ${scan.reason}`). Nodes that `depends_on` the escalate do not run.                                                                                      |
| The summary renders blank                                                             | The run pauses `escalated`, with the raw template behind `[empty summary]`; the pause fault says `summary rendered empty`. It never goes out with an empty summary.                                                                                                                                                                                                           |
| The summary is longer than 2000 characters once filled                                | It is cut at 2000 characters and ends with `…`, in the reply and in the output alike: it is cut, never dropped.                                                                                                                                                                                                                                                               |
| The answer key collides with another node's                                           | The pause fault names the collision and the reply's `node_id` is the scoped key to use.                                                                                                                                                                                                                                                                                       |

The rule behind the first three rows: an `escalate` exists to put a person in front of a decision,
so a failure of its own **fails closed** — the run stops for a person, with the marker in the
summary saying what could not be read, instead of going on without review. The person's answer
is cached with the marked summary and the run continues; read the marker to know the case was not
what the spec expected.

### Resume and cache

- `when` is read again on every run and is **not** part of the cell. A condition that stopped
  holding after an answer was recorded does not ask again: the node is `{escalated: false}`.
- The cell is `[id, "escalate", kind, summary]` with the summary as rendered, and it is written
  only **once there is an answer**. After that a resume replays it with `cache.replayed` and the
  node never asks again, whatever `checkpoint_answers` it is given.
- A different summary (the case in front of the reviewer changed) or a different `kind` is a
  new question: the node pauses again.
- It spends no leaf and no token, so it never trips the fan-out limit or the token budget.
- `workflow_preview` reports `escalation_pending` for the node that stopped the run (an
  `escalate` the run never reached is `unknown`, because it may not even fire), `replay` once it
  is answered, and `no_leaves` for one whose `when` did not hold.

### Patterns

- **Escalate only the exceptions.** An `agent` with a `schema` returns a score or a flag;
  the `escalate` tests it with `gte` or `field_true`; the nodes that act `depends_on` the escalate.
- **Hand a stuck loop to a person.** After a `loop`, escalate on
  `{"not": {"of": {"field_true": {"path": "${refine.until_met}"}}}}`: the loop gave up at its
  cap, and the summary can quote `${refine.last}`.
- **Use the answer only when there is one.** A `switch` on `${review.escalated}` with `false`
  as a `null` case and `true` as a case whose prompt reads `${review.answer}`.

### What it is not

- Not a `checkpoint`. That one always stops, takes a `default` so an unattended resume can carry
  on, and asks a `prompt`. For a sign-off that must always happen, use `checkpoint`.
- Not a model approving anything: no leaf runs, and the answer is whatever the person sends.
- No `and`/`or` in `when`; compute one field in an `agent` with a `schema`, or chain two nodes.

---

## 4. `call` — read a file or fetch a page, with no model

Reach for it when a step is **mechanical**: the file or the page is an input, and nothing in it has
to be judged yet. A `call` runs one tool and no leaf, so it costs no tokens and does the same thing
every time; the model comes in at the next node, only where something has to be judged. The
allow-list has two tools, `read_file` and `web_fetch`. `web_search`, `write_file`, `terminal` and the
`mcp_*` tools are left out on purpose: the policy does not limit where `web_search` goes, a write
has a side effect that a rerun would repeat, and a `terminal` fed by the state is a code node by
another name. A `tool` outside the list is refused when the spec is checked.

```json
{
  "meta": { "name": "route-by-settings" },
  "nodes": [
    {
      "id": "settings",
      "type": "call",
      "tool": "read_file",
      "args": { "path": "${args.path}" },
      "retries": 1
    },
    {
      "id": "route",
      "type": "switch",
      "value": "${settings.data.mode}",
      "cases": {
        "quick": null,
        "deep": { "prompt": "Review ${args.path} in depth." }
      },
      "otherwise": "deep",
      "depends_on": ["settings"]
    }
  ]
}
```

The file is read once, with no model. `settings.data` is the file's text, and because it is JSON a
`switch` reads the field `mode` of it. A page is the same shape, with the text handed to a leaf:

```json
{
  "meta": { "name": "summarise-page" },
  "nodes": [
    {
      "id": "fetch",
      "type": "call",
      "tool": "web_fetch",
      "args": { "url": "${args.url}" },
      "timeout": 20,
      "retries": 2
    },
    {
      "id": "summary",
      "type": "agent",
      "prompt": "Summarise this page in three bullets:\n${fetch.text}",
      "depends_on": ["fetch"]
    }
  ]
}
```

### The fields

| Field     | What it is                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool`    | `read_file` or `web_fetch`. Required.                                                                                                                                                                            |
| `args`    | An object of **up to 16 keys**: the arguments the tool takes (`path` for `read_file`, `url` for `web_fetch`). A value is a literal or a `${ref}`, alone or inside text, nested in an object or a list. Optional. |
| `timeout` | The deadline of **each attempt**: a positive number, **at most 120 seconds**. Without it, 30 seconds.                                                                                                            |
| `retries` | **0 to 3 retries**, none by default. Each one is a whole new attempt, with its own deadline.                                                                                                                     |

`required` and `depends_on` work as on any node. The node has **no routing knobs** (`model`,
`tier`, `effort`, `provider`) and no `prompt`: it calls no model, so there is nothing to route, and
they are refused as unknown fields.

### What it returns

The tool's own envelope, parsed, so `${fetch.text}` and `${settings.data}` read it:

- `read_file`: `ok`, `data` (the file's text), `truncated` and `path`, plus `untrusted` for a path
  the runtime marks as such.
- `web_fetch`: `ok`, `url`, `text` (the page as plain text) and `untrusted`, always `true`: it is
  content from the web, to be read and never obeyed.

`data` is text. When it is JSON, a `switch` `value`, a predicate path or a `call` arg can read a
field of it (`${settings.data.mode}`); a prompt can only take the whole `${settings.data}`.

### What runs, and what it costs

- **No leaf and no tokens.** The node does not move the run's tokens, has no row in the per-node
  cost and spawns no model. Its ledger events are `tool.started` and `tool.completed`, one pair per
  attempt, never a `leaf.started`.
- **The same sandbox as a leaf.** The call goes through the same sandbox as a leaf's tool call: the
  operator's `workflow_policy.json` limits `read_file` to `fs_allow` and `web_fetch` to
  `egress_allow`, a retired stretch is refused, and a `web_fetch` taints the session exactly as it
  does in a leaf. Once it is tainted the sandbox denies every filesystem and egress call that comes
  after — a second `web_fetch` included, in this run and in any other run of the same session — with
  `tainted run: web egress is disabled for leaves`. Put every `read_file` before the first
  `web_fetch`, and expect one `web_fetch` per session.
- **Each attempt is charged.** Each attempt takes one slot of the run's spawn limit (`lifetime`),
  as a leaf does, and no tokens. When the limit is gone the node is `null`, the run counts a
  `cap_trips`, and the tool is not called.
- **Retries.** `error` and `timeout` are retried, up to `retries` more attempts. `denied` is
  never retried: the sandbox answered before anything was dispatched, and asking again cannot change
  the policy.
- **Waiting.** The run waits for the call: it ends only after the tool answered or its deadline
  passed, so a `tool.started` never stays without its `tool.completed`.

### When it fails — never silently

| What happened                                                        | What you see                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tool failed, timed out or was denied, and the attempts are spent | The node is `null` and `faults` has `<id>: call <tool> <status> after <n> attempts: <cause>`. The cause is what the tool or the sandbox said, on one line, cut at 300 characters. Nothing is cached.            |
| An `args` ref reads a node that failed, or a field that is not there | `<id>: upstream null` and `<id>: no value for ${scan.url}`, naming every ref with no value. The tool is **not** called: it never runs on an argument that was not filled in. A `0`, `false` or `""` is a value. |
| The tool answered `ok` with text that is not a JSON object           | A failed attempt, retried like an `error`; the cause says the envelope is not valid JSON or not an object.                                                                                                      |
| The run was paused or cancelled                                      | No call is made, and none after an attempt that finds the run stopped. The node is `null` with no fault of its own, and a resume carries on. A call already in flight is awaited and kept.                      |
| The runtime has no `callTool` port                                   | An `engine fault` naming it. A node never skips quietly.                                                                                                                                                        |

Any failure is before any call or after a named attempt; there is no path where the node returns a
value it did not get from the tool.

### Resume and cache

- The cell is `[id, "call", tool, args]` with the args as resolved. A resume that finds it replays it
  with `cache.replayed` and the tool is not called again, so a file read or a page fetched once
  stays what the run saw.
- Another value for an arg, or another tool, is another cell: the tool is called again.
- `timeout` and `retries` are not part of the cell, so a resume may tighten or loosen them and still
  replay. A failed call leaves no cell, so the next run calls again.
- `workflow_preview` reports `would_call` for a call with no cell and `replay` for one with a cell.
  It never makes the call and does not add to `leaves_to_spawn`: a call is not a leaf.

### Patterns

- **Read, then route.** `read_file` a config or a manifest, then a `switch` on a field of it. The
  model never reads the file.
- **Fetch, then judge.** `web_fetch` a page, then one `agent` whose prompt takes `${fetch.text}`.
  Keep the prompt short: the whole page is in it.
- **Retry the flaky one.** `retries: 2` on a `web_fetch` covers a slow host; leave it at 0 on a
  `read_file` of a local path, where a failure is not a flake.

### What it is not

- Not a shell and not a writer: `terminal` and `write_file` are not allowed. A step that must write
  is a leaf.
- Not a reader of meaning: a page that needs judgement is read by an `agent` after the `call`.
- Not a search: `web_search` is not allowed. Give the `call` a URL.
- Not inside a `loop` or a `switch` case: those bodies are agent-shaped. Put the `call` before the
  node that needs it.

---

## 5. Checklist before calling `run_workflow` with flow control

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

For an `escalate`:

1. Is the condition something a predicate can test on one field? If not, compute that field in
   an `agent` with a `schema` first.
2. Does the `summary` say what a person needs to decide — the case, the number, the reason — and
   stay under 2000 characters once its refs are filled in?
3. Does every node that must not run before the answer `depends_on` the escalate?
4. Is the `kind` a tag I would sort by (`^[a-z][a-z0-9_]{0,31}$`), not a sentence?
5. Do later nodes read `${review.answer}` only when `${review.escalated}` is `true`?
6. Is a sign-off that must **always** happen a `checkpoint` instead?

For a `call`:

1. Is the step really mechanical: a file to read or a URL to fetch, with nothing to judge yet?
2. Is the `tool` `read_file` or `web_fetch`, and are the `args` the ones the tool takes?
3. Does every `${ref}` in `args` read a node that cannot be `null`, or am I happy for it to be
   `upstream null`?
4. Is `timeout` the longest wait I accept (at most 120 seconds), and `retries` right for a host that
   can be slow (0 to 3)?
5. Do the `read_file` calls come before the first `web_fetch`, since a `web_fetch` taints the
   session and no second one is allowed?
6. Does the node that judges the text `depends_on` the `call` and read `${fetch.text}`, not the
   whole envelope?
