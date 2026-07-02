# loom-script-runner — sandboxed R/Python script-visual executor (ACA)

Azure-native, **1:1 parity** backend for Power BI's **R / Python script visuals**.
A single-purpose FastAPI service (`app.py`) deployed as an **internal-ingress
Azure Container App** that receives a tabular `dataset` + a user-supplied R or
Python script, runs the script in a **resource-limited, env-scrubbed
subprocess**, and returns the **active figure as a static PNG**. This mirrors
Power BI's R/Python visual contract exactly — and contacts **no Power BI / Fabric
service** to do it (`.claude/rules/no-fabric-dependency.md`). The report wells
feed `dataset`; the existing Synapse `/query` **Path-3** produces the rows; this
container only *renders*.

```
platform/runners/script-runner/
  Dockerfile          # python:3.12-slim + R (r-base-core) + ggplot2; non-root runner uid 10001
  requirements.txt    # pinned: fastapi, uvicorn[standard], pandas, numpy, matplotlib
  app.py              # the REAL executor (FastAPI: GET /healthz, POST /run) — no stubs
  README.md           # this file
```

> **No vaporware** (`.claude/rules/no-vaporware.md`): `app.py` *actually* runs the
> script in a rlimited subprocess and returns a *real* PNG; the Console BFF route
> *actually* POSTs to this runner; the report-designer **Run** button *actually*
> renders the returned image. When the runner is not wired, the BFF returns an
> **honest 503** naming `LOOM_SCRIPT_RUNNER_URL` and the bicep module to deploy —
> never a mock image, never a silent empty visual.

---

## Power BI contract this implements (and where it differs, honestly)

Grounded in Microsoft Learn
(`learn.microsoft.com/power-bi/connect-data/desktop-python-visuals` and the R
visual equivalent). The executor reproduces PBI's visual contract control-for-control:

| Power BI behavior | loom-script-runner behavior |
|---|---|
| Values-well fields become a variable named **`dataset`** — a pandas `DataFrame` (Python) / `data.frame` (R) whose **column names are the field names** (no rename). | The Console wells-fold ships `{columns, rows}`; `app.py` writes `dataset.csv` and loads it as `dataset` with those exact column names. |
| Rows are **grouped + deduped** — duplicate rows collapse to one (default *Don't summarize*). | The Path-3 `buildSqlFromVisual` `SELECT … GROUP BY` already returns grouped/distinct rows; the executor does not re-summarize. |
| The script plots to the **default device**; PBI captures the **active figure** as a **static, non-interactive image**. | `MPLBACKEND=Agg` (headless) + R's PNG device; `app.py` captures the active figure to `out.png`. The result is a static PNG — no interactivity, exactly like PBI. |
| Limits: **150 k rows**, **5-min (Desktop) / 1-min (service)** timeout, **fixed DPI (72 service)**. | Row cap + **wall-clock timeout (~30 s)** + **fixed DPI (96)** — same *shape* of contract, tuned for an internal request path. The DPI/row/timeout numbers are ours and are stated here, not silently equal to PBI's. |

Because **Power BI's R/Python visual literally *is* a code editor**, the
report-designer code pane is the parity surface and is therefore **exempt from
`no-freeform-config.md`** — exactly like the ADF/Synapse expression builder. Every
*other* affordance (the field **wells** and the **R ⇄ Python** language toggle)
stays structured. The script visual is just another `DVisual` with an absolute
layout rect, positioned by `FreeFormCanvas` like any other visual — waves 0-3, the
free-form canvas, the data E2E, and the Copilot are **extended, not regressed**.

---

## API

Internal HTTP only (`external:false` ingress; port **8080**). Reached solely by
the Console BFF on the Container Apps environment / VNet — never public.

### `GET /healthz`
Liveness + readiness probe (200 `{"ok":true}` when the interpreters are loadable).
Used as the ACA `Liveness`/`Readiness` probe path.

### `POST /run`
```jsonc
// request
{
  "language": "python",            // "python" | "r"
  "script": "dataset.plot()",      // user code, <= 200 KB; rejected (413) above the cap
  "dataset": {                     // the wells-fold output (grouped + deduped)
    "columns": ["Region", "Sales"],
    "rows": [["West", 100], ["East", 80]]
  }
}
```
```jsonc
// response (200) — structured {ok,data,error} envelope per no-vaporware
{ "ok": true,  "png": "<base64>", "dpi": 96, "durationMs": 412 }
// user-script error (422) — captured stderr, NEVER the container env
{ "ok": false, "error": "NameError: name 'plt' is not defined", "stderr": "…" }
// limit hit (e.g. timeout / rlimit kill) (422)
{ "ok": false, "error": "script exceeded wall-clock timeout (30s) and was killed" }
```
`app.py` is authoritative for the exact field set; the shape above is the contract
the Console BFF and the report-designer **Run** button rely on.

---

## Build (server-side ACR Tasks — no local Docker)

Same path as `gh-aca-runner` / `loom-dbt-runner`: the boundary's GitHub-Actions
runner shells `az acr build`, so **no Docker daemon** is ever required (Container
Apps jobs don't support Docker-in-container).

```bash
az acr build \
  --registry <acr> \
  --image loom-script-runner:<tag> \
  platform/runners/script-runner
# short form: az acr build -r <acr> -t loom-script-runner:<tag> platform/runners/script-runner
```

Pin `<tag>` to the same value wired into `appImageTags` so the bicep image ref
resolves. Every dependency version is pinned (`requirements.txt` for pip; the
`python:3.12-slim` Debian-bookworm base for the apt R/ggplot2 layer) — bump
deliberately, rebuild, re-run the smoke test, then roll.

## Run locally (smoke test)

```bash
docker build -t loom-script-runner platform/runners/script-runner
docker run --rm -p 8080:8080 loom-script-runner

curl -fsS localhost:8080/healthz                       # -> {"ok":true}

# Python visual (dataset.plot())
curl -fsS -X POST localhost:8080/run \
  -H 'content-type: application/json' \
  -d '{"language":"python","script":"dataset.plot()",
       "dataset":{"columns":["x","y"],"rows":[[1,2],[3,4]]}}' \
  | python -c 'import sys,json,base64;d=json.load(sys.stdin);open("out.png","wb").write(base64.b64decode(d["png"]));print("ok",len(d["png"]))'

# R visual (plot(dataset))
curl -fsS -X POST localhost:8080/run \
  -H 'content-type: application/json' \
  -d '{"language":"r","script":"plot(dataset)",
       "dataset":{"columns":["x","y"],"rows":[[1,2],[3,4]]}}'
```

A non-empty `png` (Python) and a 200 for the R call confirm both interpreters
render on the headless Agg / PNG device.

---

## Threat model — read before changing `app.py` or the bicep

**Arbitrary user R/Python code RUNS INSIDE this container. That is by design and
is exactly Power BI's posture** — PBI runs each visual's script in a locked
container too. **The container is the sandbox boundary.** `app.py` trusts no
request body. The defenses, in depth:

1. **Non-root** — the service and every spawned user script run as the
   unprivileged `runner` user (**uid 10001**); nothing under `/app` is
   root-owned or root-writable at runtime.
2. **Internal ingress only** — the ACA app is deployed `external:false` (never
   public). Only the Console BFF, inside the same CAE / VNet, can reach it.
3. **Ephemeral `/tmp`** — `app.py` `mkdtemp()`s a fresh **0700** dir per request
   (`dataset.csv` / the script / `out.png` live only there) and
   `shutil.rmtree()`s it in `finally`.
4. **Scrubbed minimal env** — the child is spawned with a **fresh dict**
   (`PATH`, `HOME=tempdir`, `MPLBACKEND=Agg`, `LANG` only) — **never
   `os.environ`** — so no inherited secret, connection string, or token is
   visible to user code.
5. **POSIX rlimits** (`preexec_fn`) — `RLIMIT_CPU` (~25 s), `RLIMIT_AS`
   (~1.5 GB), `RLIMIT_FSIZE` (~50 MB), `RLIMIT_NPROC`.
6. **Process-group kill** — `start_new_session=True` + a **wall-clock timeout
   (~30 s)** that `os.killpg(SIGKILL)`s the **whole** process group, so a script
   that forks cannot outlive the request.
7. **Input/output caps** — script size (**200 KB**), row/cell counts, and the
   output PNG size are all bounded before/after execution.

### What is NOT claimed
This is **process-level** isolation (non-root + rlimits + scrubbed env + a
locked-down container), the same class of sandbox Power BI uses. It is **not**
VM-level, gVisor, or kernel-syscall-filtered isolation. A kernel-level escape is
out of scope of these defenses; mitigate at the platform layer (ACA tenancy +
the egress restriction below).

### Identity hardening (the one that bites)
An ACA app exposes its **assigned managed identity to in-container code via
IMDS**. Because user code runs here, the runner **MUST** use a **dedicated,
least-privilege** identity — **`uami-loom-script-runner` with `AcrPull` and
ZERO data-plane roles**. Reusing the broadly-permissioned **Console UAMI** is a
**genuine sandbox hole**: user code could mint IMDS tokens for Storage / Cosmos /
ARM. If an interim Console-UAMI reuse is unavoidable on a given deploy, it is
recorded here as a **known weakness to tighten**, never relied on silently. The
runner itself **holds no data credentials** (defense 4 keeps even its own env out
of the child). **Defense-in-depth:** restrict egress at the CAE / NSG so even a
minted token has no network path off-box.

---

## Wiring (bicep-sync — `no-vaporware.md`)

The runner is deployed and consumed entirely through bicep; nothing is wired by
hand. This is the **first new BFF route the report program adds** (waves 0-3 added
zero — they all reused the unchanged `/query` Path-3), called out honestly in
`docs/fiab/parity/report-designer.md`.

1. **ACA app** — `modules/admin-plane/script-runner-app.bicep`, modeled on the
   sibling `modules/integration/dbt-runner.bicep`: internal ingress
   `external:false`, `targetPort: 8080`, ACR pull
   via the runner UAMI, `minReplicas: 0` (scale-to-zero between renders), and a
   `/healthz` liveness/readiness probe. It **outputs the internal endpoint** the
   Console reads as `LOOM_SCRIPT_RUNNER_URL`.
2. **Console env** — `LOOM_SCRIPT_RUNNER_URL` is added to the Console container's
   env array in `admin-plane/main.bicep` (beside the `LOOM_DBT_RUNNER_URL` line),
   set to the runner's internal endpoint when a `scriptRunnerActive` gate is on
   (Container Apps + apps deployed + image present), `''` otherwise.
3. **Honest gate** — when `LOOM_SCRIPT_RUNNER_URL` is empty/unset, the BFF route
   returns **503** naming the env var **and** the `script-runner-app.bicep`
   module, and the report-designer surfaces the documented Fluent `MessageBar`
   (`intent="warning"`). The script-visual gallery entry still **renders** (a
   dark-legible Fluent v9 glyph matching the just-shipped picker — `web3-ui.md`);
   only **Run** is gated until the runner is deployed.

### Rules honored
- **no-vaporware** — real subprocess, real PNG, real BFF call, real UI render; honest 503 + bicep-sync.
- **no-freeform-config** — the code editor is PBI 1:1 parity (the visual *is* a code editor), exempt like the ADF expression builder; wells + language toggle stay structured.
- **no-fabric-dependency** — Azure-native ACA + the existing Synapse `/query` Path-3; no Power BI / Fabric service is contacted.
- **web3-ui** — Loom tokens + Fluent v9; the new gallery glyph matches its siblings, dark-legible.
- **bicep-sync** — `script-runner-app.bicep` + the `LOOM_SCRIPT_RUNNER_URL` console env land in the same change set.

Pin all container versions; add **no new** TypeScript errors (~181 pre-existing,
unrelated). The free-form canvas, waves 0-3, the data E2E, and the Copilot are
extended, not regressed.
