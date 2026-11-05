---
name: workflow-flow-control
description: Make a dynamic workflow take a different road depending on what an earlier node returned. Covers the `switch` node — pick one of 2 to 16 cases by the value of a field in the run's state and run only that case's leaf, with an `otherwise` and a `null` case that runs nothing. Load it after `workflow-authoring` when the next step depends on a value (reuse an answer vs investigate, stop early vs continue). Do NOT load for a straight-line workflow where every node always runs, for a fan-out over a list (`parallel`, `pipeline`), or for a human sign-off (`checkpoint`).
version: 1.0.0
---

# Flow control in dynamic workflows

A workflow runs every node of its graph, in dependency order. That is the right
default, and it is wasteful when the answer to an early question makes the later
work pointless: "we already solved this", "the input is out of scope", "this one
needs a person". `switch` is the block that lets a spec take a different road
**without** a different graph: the roads live inside one node, and only the one
that matches the state runs.

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

- Not a loop and not a fan-out: one value, one leaf. Fan out with `parallel` or `pipeline`.
- A case body is agent-shaped. It cannot hold a `workflow`, a `checkpoint` or another
  `switch`; put those in their own nodes.
- No expressions: `value` is a single `${ref}`. Compute the value in an `agent` with a
  schema, then switch on its field.

---

## 2. Checklist before calling `run_workflow` with a `switch`

1. Is `value` exactly one `${ref}`, to a field whose possible values I know?
2. Does the node producing it have a `schema` with an `enum` of the case names?
3. Is there an `otherwise` — or am I happy for an unexpected value to be a fault?
4. Which case should run nothing? Make it `null`, not an agent that says "nothing to do".
5. Do later nodes read `${route.output}` where a `null` case would leave them with `upstream null`?
6. Are the routing knobs on the node, not inside a case?
