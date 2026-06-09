# spark-compute — parity with Fabric notebook Spark compute

Source UI: Fabric notebook **Spark session** / Azure ML Serverless Spark
Reference: <https://learn.microsoft.com/azure/machine-learning/how-to-submit-spark-jobs>
Also: <https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session>
Run date: 2026-06-09

Loom surfaces:

- Commercial/GCC backend: `lib/azure/aml-spark-client.ts` → `AmlSparkClient`,
  `AmlSparkNotConfiguredError`
- Cell wrapper: `lib/azure/aml-spark-runner.ts` → `buildRunnerPy()`
- GCC-High/IL5 backend: `lib/azure/synapse-livy-client.ts` (Livy interactive
  sessions)

This is the **notebook Spark cell-execution backend** — distinct from
`spark-environment.md` (the Environment item editor). The Fabric Spark capacity
maps **Azure-native** to Azure ML Serverless Spark (public clouds) or Synapse
Livy (government). There is **no dependency on real Microsoft Fabric** — cells
execute against Azure Spark with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Execute a `%%pyspark` cell against a managed Spark pool
2. Capture stdout / results
3. Interactive session lifecycle (create, keepalive, teardown)
4. Spark magic commands (`%%configure`, `%%info`, etc.)
5. Per-session Spark config

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| `%%pyspark` cell execution (Commercial/GCC) | ✅ Built | AML Serverless Spark standalone job: upload `run.py` blob → register code asset → submit `jobType:'Spark'` → poll → read `result.json` |
| Cell stdout capture | ✅ Built | `buildRunnerPy()` uses `contextlib.redirect_stdout` + base64-encoded cell source |
| `%%pyspark` cell execution (GCC-High/IL5) | ✅ Built | Synapse Livy interactive sessions: `createLivySession()` → `createLivyStatement()` → poll → `normalizeLivyOutput()` |
| Livy magic interception (`%%configure`, `%%info`, …) | ✅ Built | `parseMagicKind()` + `parseConfigureMagic()` |
| Per-session Spark config | ✅ Built | `parseConfigureMagic()` applied to session create |
| Session keepalive | ✅ Built | `keepaliveLivySession()` |
| Session teardown | ✅ Built | `killLivySession()` |
| AML backend config gate | ⚠️ Honest gate | `AmlSparkNotConfiguredError` names the missing env (`LOOM_AML_WORKSPACE` …) + bicep module |
| Livy backend config gate | ⚠️ Honest gate | route checks `LOOM_SYNAPSE_WORKSPACE`; 503 with exact hint |

Zero ❌ rows. Both backends are fully built; the only ⚠️ gates are honest
infra-config gates naming the exact env var / module, per `no-vaporware.md`.

## Backend per control

- **Commercial/GCC** — `AmlSparkClient` runs each cell as an AML Serverless
  Spark standalone job: it uploads a generated `run.py` (from `buildRunnerPy()`,
  which wraps the user's base64-encoded cell source in a stdout redirect) to
  blob, registers it as a code asset, submits a `jobType:'Spark'` job, polls to
  terminal, and reads back `result.json`.
- **GCC-High/IL5** — `synapse-livy-client.ts` drives Synapse Spark Livy
  interactive sessions: create session (with any `%%configure` config) →
  `createLivyStatement()` per cell → poll → `normalizeLivyOutput()`; magic
  commands are intercepted client-side; sessions are kept alive and torn down
  explicitly.
- **Gates** — each backend throws a typed *NotConfigured* error that the BFF
  renders as a MessageBar naming the env var + bicep module to provision.

## Per-cloud notes

| Cloud | Default backend |
|---|---|
| Commercial | AML Serverless Spark (`LOOM_NOTEBOOK_BACKEND=aml-spark`) |
| GCC | AML Serverless Spark (Azure public) |
| GCC-High | Synapse Livy — AML Serverless Spark unavailable in Azure Government |
| IL5 | Synapse Livy |

## Bicep sync

- AML path: `LOOM_AML_WORKSPACE` (+ subscription/RG) env in `admin-plane/main.bicep`
  `apps[]`; the AML workspace + the console UAMI's `AzureML Data Scientist` grant
  are in the landing-zone bicep.
- Livy path: `LOOM_SYNAPSE_WORKSPACE` env; Synapse Spark pool + UAMI Synapse
  roles in the landing-zone bicep. The `il5.bicepparam` / `gcc-high.bicepparam`
  default `LOOM_NOTEBOOK_BACKEND=synapse-livy`.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — AML or Livy,
  never a Fabric host.
- Live walk (Commercial): run a `%%pyspark` cell, confirm the AML job is
  submitted and `result.json` stdout is returned. Live walk (GCC-High): run a
  cell, confirm a Livy session is created, the statement executes, output is
  normalized, and the session is kept alive then torn down.

Grade: **A** — both Azure-native Spark backends fully built with magic/session
support; only honest infra-config gates.
