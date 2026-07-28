# Tutorial: Model serving endpoint editor

> CSA Loom `model-serving-endpoint` editor — deploy a registered model behind an
> HTTPS scoring endpoint on **Azure ML managed online endpoints** (the
> Azure-native **default**) or **Databricks Mosaic AI Model Serving** (opt-in via
> `LOOM_MODEL_SERVING_BACKEND=databricks`). One-for-one with the Azure ML
> *Endpoints* / Databricks *Serving* experience. **No Microsoft Fabric.**

## What it is

The last mile of an ML workflow: take a registered model version, put it behind
a managed HTTPS endpoint, canary a new version with a **blue/green traffic
split**, score it from a console, and watch real Azure Monitor metrics — all
without leaving Loom.

Four tabs:

| Tab | What it does |
|---|---|
| **Overview** | Backend badge, live endpoint list, select / bind, endpoint state, per-row Traffic and Delete |
| **Deployments & traffic** | Create an endpoint, the deployments table, and the traffic-split dialog |
| **Invoke** | Scoring console — a real POST with measured round-trip latency |
| **Monitoring** | Live latency / requests / error tiles and charts from Azure Monitor |

## When to use it

- A registered model needs a production HTTPS scoring surface.
- You want to canary a new model version at 10% traffic before promoting it.
- You need latency and error-rate telemetry attached to the endpoint you own.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Model serving endpoint**. The header
   badge names the active backend (Azure ML managed online endpoints by default).
2. **See what already exists.** **Overview** lists live endpoints read from the
   real backend, with their state. Click a row to select it — that selection
   drives the Invoke and Monitoring tabs. Each row also offers **Traffic** and
   **Delete**.
3. **Create an endpoint.** On **Deployments & traffic → Create a serving
   endpoint**:
   - **Endpoint name** (for example `fraud-scorer`).
   - **Registered model** — a dropdown of your real registered models (with the
     latest version pre-selected); falls back to a text input if the registry
     could not be listed.
   - **Version**.
   - **Instance type** (Azure ML, for example `Standard_DS3_v2`) or **Workload
     size** (Databricks, for example `Small`).
   - **Scaling** — `Manual` (fixed **Instances**) or `Autoscale` (**Min** /
     **Max instances**).
   - **Scale to zero when idle** — a switch, Databricks backend only.

   **Create endpoint** deploys the model version and routes **100% of traffic to
   the first ("blue") deployment**.
4. **Review the deployments.** The deployments table lists deployment name,
   model, compute (type ×count), scale type, current traffic percentage, and
   state.
5. **Canary a new version.** Add a second deployment, then **Split traffic**.
   The dialog gives one slider per deployment in 5% steps with a running total
   badge; **Apply split** is enabled only when the total is exactly **100%** and
   applies a real backend update (blue/green canary).
6. **Score it.** On **Invoke**, edit the JSON body to match your model's
   signature and click **Invoke**. Loom sends a real scoring request and shows
   the HTTP status badge, the measured **round-trip latency in ms**, and the raw
   response body.
7. **Watch it run.** **Monitoring** shows three tiles — average request latency,
   requests per minute, and 5xx errors per minute (red when non-zero) — plus
   time-series charts, sourced live from **Azure Monitor**
   (`Microsoft.MachineLearningServices/workspaces/onlineEndpoints`:
   `RequestLatency`, `RequestsPerMinute`). **Refresh** re-reads them.

## The Azure backend it rides on

- **Serving (default):** **Azure ML managed online endpoints** — real ARM
  create/update, deployments, and traffic routing.
- **Serving (opt-in):** **Databricks Mosaic AI Model Serving**, selected with
  `LOOM_MODEL_SERVING_BACKEND=databricks`.
- **Metrics:** **Azure Monitor** metrics for the online endpoint resource.
- **Routes:** `GET/POST/DELETE /api/items/model-serving-endpoint/<id>`,
  `…/traffic`, `…/invoke`, `…/metrics` — every control calls a real BFF route.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| No serving backend configured | The shared Fix-it gate (`svc-model-serving`) with an inline wizard; the whole surface still renders and the create form's inputs are disabled — no red banner on a fresh item | Set the variable the gate names via its **Fix it** wizard |
| Endpoint has no deployments yet | *"No deployments yet — the endpoint may still be provisioning"*; **Split traffic** is disabled | Wait for provisioning, or create a deployment |
| Traffic percentages do not total 100 | **Apply split** stays disabled and the total badge turns amber | Adjust the sliders until the total is 100% |
| Endpoint-level metrics unavailable (Databricks path) | An info MessageBar stating the reason honestly, instead of empty charts | Use the backend's own serving telemetry, or switch to the Azure ML path |
| No endpoint selected | Invoke / Monitoring prompt you to select one | Pick an endpoint on **Overview** |

## No Fabric required

Azure ML (or Databricks) + Azure Monitor. No Fabric capacity, workspace, OneLake
path, or Power BI workspace is used on any path.

## Learn more

- Feature table editor tutorial: `editor-feature-table.md`
- ML model editor tutorial: `editor-ml-model.md`
- Fine-tuning job editor tutorial: `editor-fine-tuning-job.md`
- Azure ML online endpoints:
  <https://learn.microsoft.com/azure/machine-learning/concept-endpoints-online>
