# Self-healing NL2SQL

> **Surface:** no dedicated UI — it runs inside the data-agent reasoning loop and surfaces as **repair attempts** in the [answer receipt](answer-receipts.md) and the reasoning trace
> **Backend:** the same real backends the step was already running against (Synapse serverless / dedicated SQL, ADX, lakehouse, graph); the rewrite is a schema-grounded model call on the reasoning tier
> **Kill-switch flag:** none — instead, a bounded knob: `LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS` (unset = 2, clamped to 0-5)
> **Honest gate:** none

Generated SQL fails for boring reasons: a column was renamed, a table moved
schema, the model guessed a function that dialect does not have. Self-healing
NL2SQL catches those failures inside the reasoning loop, re-reads the **live**
schema, rewrites the query, and retries — a bounded number of times — instead of
handing the user an error or, worse, a confident answer built on zero rows.

It also adds the check nobody asks for and everybody needs: **does the final
answer actually follow from the rows the backends returned?**

## Why it exists

The reasoning loop already plans, executes and verifies. Before this feature a
step that hit `Invalid column name 'CustomerID'` simply failed, and the loop
narrated around the hole. Two distinct failure modes needed closing:

1. **Repairable execution failure** — the query was malformed or drifted from the
   live schema. A schema-grounded rewrite genuinely fixes this.
2. **Implausible success** — every executed query returned zero rows, yet the
   prose answer asserts figures. That is the hallucination shape that survives
   every syntax check.

## How it behaves end to end

The loop runs per plan step. For each step:

1. **Execute** the step's generated query against the real backend.
2. **Classify the outcome** — purely from the backend's own metadata (did it
   execute, what gate came back, how many rows), never from the model's prose:
   - the step threw, or the tool reports a gate matching a known repairable
     error class (invalid object name, invalid column name, incorrect syntax,
     could not be bound, no such table/column, does not exist, unknown
     table/column/function, undefined table/column, ambiguous column, syntax
     error, parse error, semantic error, failed to resolve, cannot find the
     table/column) → **repairable**;
   - every executed query returned **zero rows** → **repairable** (implausible
     for the sub-question);
   - otherwise → not repairable, move on.
3. **Repair, bounded.** On a repairable outcome the loop re-reads the **live**
   warehouse schema, hands the model the failing query plus the real error plus
   the fresh schema, and asks for a rewrite. It re-consults the
   [governed metric registry](verified-queries.md) on every attempt so a rewrite
   stays inside the semantic contract rather than drifting out of it. Default
   two attempts per step.
4. **Plausibility check on the final answer.** After the last step the loop
   compares the numeric figures asserted in the prose against the rows the
   backends actually returned:
   - no step executed a query at all → **not plausible** (the answer is not
     grounded in returned rows);
   - zero rows seen overall, and the answer does *not* say so → **not
     plausible**;
   - single digits and bare four-digit years are ignored as narration (step
     numbers, ordinals, dates), so the check does not fire on prose noise.
5. **Report everything.** Each repair attempt and the plausibility verdict are
   attached to the step result and flow into the persisted
   [answer receipt](answer-receipts.md) and the reasoning trace in the data-agent
   editor.

Nothing here is silent. A repaired answer says it was repaired; an implausible
answer says it is implausible.

## Tuning

`LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS` is an optional knob registered in the gate
registry as an optional default. **Unset is the fully-functional default of 2.**
The value is truncated and clamped to the range 0-5, so a mistyped value can
never produce an unbounded loop. Setting `0` disables repair while leaving the
plausibility check in place.

Note for operators reading the code: an empty string coerces to `0` in
JavaScript, so the implementation deliberately treats *unset* as "fall through to
2" rather than "disable" — an unset variable never silently switches the repair
loop off.

## What the backend actually does

| Step | Backend |
|---|---|
| Failure classification | Pure inspection of the executed tool metadata (`executed`, `gate`, `rowCount`) |
| Live schema re-read | The same schema endpoint the grounded execution path already uses; soft-fails to an empty string rather than blocking a retry |
| Rewrite | A reasoning-tier model turn through the tier router (falls back to the standard deployment when no reasoning deployment is configured) |
| Metric re-check | The `loom-semantic-contract` registry |
| Plausibility | Pure comparison of asserted figures against the real captured rows |

## Honest gates

None. Two honest degradations:

- **No reasoning deployment configured.** The loop still runs and still executes
  for real; the rewrite simply rides the standard deployment, and the surface
  reports that the reasoning tier is not configured with a Fix-it.
- **Schema re-read unavailable.** The repair attempt proceeds without the fresh
  schema rather than aborting the step.

## Kill-switch

There is no runtime flag for the repair loop itself — it has no surface to
revert and it cannot make an answer worse (a failed repair leaves the step
exactly as it already was). The bounded knob above is the control. The two
features it composes with each have their own switches:
`n9-verified-queries-tab` and `n10-answer-receipts`.

## Related

- [Verified queries and the semantic contract](verified-queries.md) — the boundary a repair must stay inside
- [Answer receipts](answer-receipts.md) — where repair attempts and the plausibility verdict surface
- [GraphRAG grounding](graphrag-grounding.md)
- Editor guide — [Data agent](../tutorials/editor-data-agent.md)
