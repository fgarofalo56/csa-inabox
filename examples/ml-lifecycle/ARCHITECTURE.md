# ML Lifecycle Example — Architecture

> Companion to [`README.md`](./README.md).  Documents the component graph,
> data flow, contracts, and key design decisions for the loan-default
> classifier example.

## Component Diagram

```mermaid
flowchart TB
    subgraph src["Sources (synthetic)"]
        G[generate_loan_data.py<br/>seed=42 → deterministic CSV]
    end

    subgraph bronze["Bronze (raw)"]
        B1[brz_loan_applications.sql<br/>type coercion only]
    end

    subgraph silver["Silver (cleaned)"]
        S1[slv_loan_features.sql<br/>FICO clip + winsorise<br/>+ derived ratios]
    end

    subgraph gold["Gold (training set)"]
        Gd[gld_training_features.sql<br/>PII-free predictors + label]
    end

    subgraph train["Training"]
        T1[train.py<br/>StandardScaler + OneHot<br/>+ LogisticRegression]
        M[model.pkl + metrics.json]
    end

    subgraph serve["Serving"]
        S2[score.py<br/>init()/run()]
        EP[Managed Online<br/>Endpoint]
    end

    subgraph monitor["Monitoring"]
        D[drift_detection.py<br/>Evidently / PSI]
        ALERT[Alert Channel]
    end

    G --> B1 --> S1 --> Gd --> T1 --> M --> S2 --> EP
    Gd -.reference snapshot.-> D
    EP --> D --> ALERT
```

## Data Flow

1. **Generation.** `generate_loan_data.py` uses a seeded NumPy generator to produce 5000 loan applications (default).  Same seed + same row count ⇒ identical SHA-256.
2. **Bronze.** `brz_loan_applications.sql` reads the dbt seed (CI) or the Delta landing table (prod) and applies type coercion only.  No filtering.
3. **Silver.** `slv_loan_features.sql` winsorises `annual_income` below `income_floor_usd`, clips `credit_score` to the FICO range, caps `debt_to_income`, and derives `monthly_payment`, `payment_income_ratio`, `amount_income_ratio`.
4. **Gold.** `gld_training_features.sql` exposes only the columns in the training contract (no `application_id`, no `application_ts`).  One-to-one with `contracts/loan_training_features.yaml`.
5. **Training.** `train.py` reads the gold set (or re-generates synthetically for offline tests), stratifies 75/25, fits the sklearn pipeline, asserts AUC, writes `model.pkl` via joblib.
6. **Registration.** `register_model.sh` uploads the `outputs/` folder to the AML model registry (`custom_model` type).
7. **Deployment.** `deploy_endpoint.sh` emits a `managedOnlineDeployment.schema.json`-compliant YAML, calls `az ml online-deployment create`, shifts 100% traffic to the `blue` deployment.
8. **Inference.** AML invokes `score.init()` on container start and `score.run(body)` per request.  `score.score_records()` is the standalone entry point used by tests.
9. **Drift.** `drift_detection.py` compares a recent `current` snapshot against a `reference` snapshot (usually the training set).  When drift > threshold, the exit code is `1` — hook this up to a Container Apps Job + alert.

## Contracts

| Contract | Enforced by |
|---|---|
| `loan_training_features.yaml` — field types, ranges, enums, PKs | dbt model tests (`accepted_values`, `not_null`, `unique`) |
| `loan_training_features.yaml` — AUC >= 0.70 | `test_train.py::test_auc_clears_contract_threshold` |
| `loan_prediction_contract.yaml` — probability in [0,1], prediction in {0,1} | `test_score.py::test_run_returns_valid_predictions` |
| `loan_prediction_contract.yaml` — drift SLO | `drift_detection.py` exit code |

## Key Design Decisions

1. **Deterministic synthetic data.**  CI cannot depend on real production data.  `generate_loan_data.py` uses an explicit NumPy `default_rng(seed)` and formats timestamps from a fixed epoch so the SHA-256 is reproducible.  Training tests can then assert exact AUC stability.
2. **sklearn over Azure ML AutoML.**  AutoML is opaque and slow for a tiny worked example.  Logistic regression clears AUC 0.70 on our synthetic data in ~3 seconds, so the whole end-to-end pipeline runs in CI.
3. **PSI fallback for drift.**  `evidently` is a 200 MB transitive dep (brings pandas, plotly, typing_extensions, scipy).  Many CI jobs don't need it, so we ship a pure-NumPy PSI + quantile-binning fallback that produces comparable dataset-level verdicts.  Evidently is used when available; otherwise the fallback path.
4. **Standalone `score.run()`.**  The Azure ML inference server calls `init()` and `run()`; our `score_records()` helper does the same work without going through the AML wrapper, making local integration tests trivial.
5. **dbt model profile reuse.**  The dbt project declares profile `csa_ml_lifecycle`, mapped to the same in-memory DuckDB stub used by every other vertical in the monorepo.  `.github/workflows/dbt-ci.yml` already lists it under the matrix and the stub profile block.
6. **No top-level `sources:` in `dbt_project.yml`.**  Follows the lint in the IoT streaming project — sources live in `models/schema.yml` where dbt expects them.

## Security Posture

- Storage: shared key enabled for AML artifact uploads; public access disabled at the blob container level (workspace creates its own with `allowBlobPublicAccess: false`).
- Key Vault: RBAC auth, soft-delete + purge-protection enabled.
- Online endpoint: key auth by default; swap to AAD via `authMode: 'AADToken'` in `main.bicep` for FedRAMP High.
- AML workspace: system-assigned identity; grant least-privilege data-scientist role to the admin AAD group.

## Deferred / Non-Goals

- Private endpoints / VNet integration — the `main.bicep` is intentionally public-facing for a quick-start example.  Production deployments should layer in `shared/modules/privateEndpoint.bicep` and the shared private DNS zones.
- AKS-based inference — managed online endpoints are simpler for the example; replace with `deploymentTarget: 'AksCompute'` for workloads that need GPUs or VNet isolation.
- Real credit-bureau features — Silver is a single-table pipeline for clarity.
