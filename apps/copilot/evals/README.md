# Copilot Eval Harness

CI-runnable quality gate for the CSA Copilot. Runs a fixed set of
goldens against the agent, scores each response on five rubrics, and
compares the aggregate against a committed baseline to detect
regressions before they ship.

## Directory layout

```
apps/copilot/evals/
  README.md                # this file
  models.py                # frozen DTOs (EvalReport, EvalResult, ...)
  rubrics.py               # rubric implementations
  harness.py               # EvalHarness orchestrator (async, concurrency)
  scorer.py                # LLM-as-judge + deterministic scorer
  regression.py            # RegressionGate
  cli.py                   # python -m apps.copilot.evals ...
  goldens_schema.py        # JSON-schema loader + validator
  goldens/
    _schema.json           # JSON-schema for golden YAMLs
    corpus_qa.yaml         # 20+ in-corpus goldens
    refusal.yaml           # 10+ off-corpus (must-refuse) goldens
    conversation_multiturn.yaml  # 5+ multi-turn goldens
  baselines/
    README.md              # how to capture + commit baselines
    baseline_v0.1.0.json   # committed initial baseline
  tests/...
```

## Authoring goldens

Each golden YAML file has the top-level shape:

```yaml
goldens:
  - id: stable-case-id
    skill: grounded-corpus-qa          # default when omitted
    question: "The user question."
    conversation_id: null              # optional; ties multi-turn cases together
    expected_citations:                # list of source_path strings
      - docs/migrations/palantir-foundry.md
    expected_phrases:                  # answer should mention these (case-insensitive)
      - "Unity Catalog"
      - "Purview"
    must_refuse: false                 # true for off-corpus cases
    thresholds:                        # per-case thresholds; all optional
      groundedness: 0.85
      citation_accuracy: 0.90
      answer_relevance: 0.70
      refusal_correctness: null
    tags: [migrations, palantir]
```

Every golden is validated against `goldens/_schema.json`. Schema
failures surface as `GoldenSchemaError` with line-numbered issues.

## Running the harness

### Dry-run (CI)

Uses the deterministic `DryRunAgent` + `DeterministicScorer`. No Azure
credentials, reproducible, fast.

```bash
python -m apps.copilot.evals run \
  --goldens apps/copilot/evals/goldens/corpus_qa.yaml \
  --output evals_out.json \
  --dry-run
```

### Live run (local)

Live runs require a live agent; build the harness programmatically:

```python
import asyncio
from apps.copilot.agent import CopilotAgent
from apps.copilot.config import CopilotSettings
from apps.copilot.evals import EvalHarness

settings = CopilotSettings()
agent = CopilotAgent.from_settings(settings)

async def agent_call(question, conversation_id=None):
    return await agent.ask(question)

harness = EvalHarness(agent=agent_call, deterministic=False)
goldens = EvalHarness.load_goldens("apps/copilot/evals/goldens/corpus_qa.yaml")
report = asyncio.run(harness.run(goldens))
```

## Regression gate

```bash
python -m apps.copilot.evals gate \
  --current evals_out.json \
  --baseline apps/copilot/evals/baselines/baseline_v0.1.0.json \
  --max-score-regression 0.02 \
  --max-latency-p95-regression-pct 10
```

Exit codes:

* `0` — no regression
* `1` — regression detected (blocks merge)
* `2` — runtime error

## Diffing two runs

```bash
python -m apps.copilot.evals diff --a run_a.json --b run_b.json
```

Prints per-case score + latency deltas.

## Capturing a new baseline

```bash
# 1. Run the current agent against the full golden set
python -m apps.copilot.evals run \
  --goldens apps/copilot/evals/goldens/corpus_qa.yaml \
  --output evals_out.json \
  --dry-run \
  --tag v0.1.1

# 2. Stamp the baseline
python -m apps.copilot.evals baseline \
  --from evals_out.json \
  --tag v0.1.1

# 3. Commit apps/copilot/evals/baselines/baseline_v0.1.1.json
```

## Observability

Every eval run emits OTel spans:

* `copilot.evals.run` — top-level span with run_id attribute.
* `copilot.eval.<case_id>` — one span per case, with
  `copilot.eval_latency_ms`, `copilot.groundedness`, and
  `copilot.refused` attributes.

With `COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT` configured, these flow to
your tracing backend alongside `trace_id`/`span_id`-enriched structlog
events. See `apps/copilot/telemetry/README.md` for the full list of
canonical attribute names.
