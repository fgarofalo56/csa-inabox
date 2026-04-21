# Eval Baselines

Committed baseline snapshots used by the regression gate.

## When to capture

Capture a new baseline when:

1. The corpus genuinely improved (new docs, better chunking) and the
   gate is blocking on a legitimately-updated score distribution.
2. The golden set was expanded / reshaped and the prior baseline is no
   longer representative.
3. The prompt set bumped a major version and the expected response
   shape changed meaningfully.

Do NOT capture a new baseline to silence a real regression — that
defeats the gate's purpose. Investigate the regression first.

## How to capture

```bash
python -m apps.copilot.evals run \
  --goldens apps/copilot/evals/goldens/corpus_qa.yaml \
  --output /tmp/new_report.json \
  --dry-run \
  --tag v0.2.0

python -m apps.copilot.evals baseline \
  --from /tmp/new_report.json \
  --tag v0.2.0
```

The resulting `baseline_v0.2.0.json` is committed alongside a brief
note in the commit message explaining why.

## How the gate picks the baseline

The CI workflow hard-codes the path in `.github/workflows/copilot-evals.yml`:

```yaml
--baseline apps/copilot/evals/baselines/baseline_v0.1.0.json
```

Update the workflow when you roll a new baseline. Keep ONE active
baseline — historical versions remain committed for audit but are not
consulted at merge time.
