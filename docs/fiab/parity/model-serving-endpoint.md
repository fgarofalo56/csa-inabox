# model-serving-endpoint — parity with Azure ML managed online endpoints (and Databricks Mosaic AI Model Serving)

**Source UI:** Azure Machine Learning studio → **Endpoints → Real-time endpoints**
(the Azure-native default), and Databricks → **Serving** (the opt-in alternative).
Grounded in Microsoft Learn / Databricks docs:

- https://learn.microsoft.com/azure/machine-learning/concept-endpoints-online
- https://learn.microsoft.com/azure/machine-learning/how-to-deploy-online-endpoints
- https://learn.microsoft.com/azure/machine-learning/how-to-safely-rollout-online-endpoints
- https://learn.microsoft.com/azure/machine-learning/how-to-autoscale-endpoints
- https://learn.microsoft.com/azure/machine-learning/how-to-authenticate-online-endpoint
- https://learn.microsoft.com/azure/machine-learning/how-to-monitor-online-endpoints
- https://learn.microsoft.com/rest/api/azureml/online-endpoints
- https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-machinelearningservices-workspaces-onlineendpoints-metrics
- https://docs.databricks.com/api/azure/workspace/servingendpoints

**Loom surface:** `apps/fiab-console/lib/editors/model-serving-endpoint-editor.tsx`
→ `ModelServingEndpointEditor` (registered for `model-serving-endpoint` in
`lib/editors/registry.ts`). Runtime `lib/azure/model-serving-client.ts` (the
two-backend facade) + `lib/azure/model-serving-item.ts`. BFF routes under
`app/api/items/model-serving-endpoint/[id]/` — `route.ts` (list / create /
delete), `traffic/route.ts`, `invoke/route.ts`, `metrics/route.ts`.

**Backend, per `no-fabric-dependency.md`:** the DEFAULT is Azure-native — Azure ML
managed online endpoints (`Microsoft.MachineLearningServices/workspaces/onlineEndpoints`,
real ARM control plane + real data-plane scoring). Databricks Mosaic AI Model
Serving is opt-in via `LOOM_MODEL_SERVING_BACKEND=databricks`. No Fabric anywhere
on either path.

**Why this doc exists:** #3723. A 2026-08-18 re-sweep cross-checked all 142
`FABRIC_ITEM_TYPES` slugs against `docs/fiab/parity/` and found this item type was
the ONLY one with no parity doc at all — so it had never been through the
`ui-parity.md` inventory-and-grade process, and nobody knew whether it was fine or
the least-audited surface in the product.

**Last verified: 2026-08-29, by READING the current code** — the editor, the
client facade and the four BFF routes named above. That is a static audit and it
is stated as one: no in-browser walk and no live Azure endpoint were exercised for
this pass, so the grade below is capped accordingly (see *Grade*).

---

## Source-UI feature inventory (grounded in Learn / Databricks docs)

### A. Endpoint lifecycle
1. **List** real-time endpoints with name, provisioning state and traffic split.
2. **Create** an endpoint (name + auth mode + a first deployment).
3. **Delete** an endpoint.
4. **Endpoint details** — scoring URI, provisioning state, auth mode, identity.
5. **Consume / sample code** tab — REST snippet, key/token retrieval, SDK samples.
6. **Tags / description** on the endpoint.

### B. Deployments
7. **Add a deployment** to an existing endpoint: registered **model + version**,
   environment, scoring script, **instance type** (VM SKU) and **instance count**.
8. **Autoscaling** — min/max instances, scale rules (AML uses Azure Monitor
   autoscale; Databricks exposes workload size + **scale-to-zero**).
9. **Deployment list** with per-deployment model, compute, scale and state.
10. **Update / delete** a single deployment independently of the endpoint.
11. **Deployment logs** — container/init logs for a failing deployment.
12. **Test tab, per deployment** — score a specific deployment directly.

### C. Safe rollout
13. **Traffic split** across deployments (blue/green, canary), integer percentages
    summing to 100.
14. **Mirror traffic** — shadow a percentage of live traffic to a new deployment
    without returning its responses (AML-specific).

### D. Invocation
15. **Test / scoring console** — send a JSON payload, see the response.
16. **Round-trip latency** for the test call.
17. **Auth** — key or Entra token based invocation.

### E. Monitoring
18. **Metrics** — request latency, requests/min, errors by status-code class.
19. **Charts over a selectable timespan**.
20. **Alerts / diagnostic settings** wiring to Log Analytics.

### F. Networking & identity
21. **Public network access** toggle / private endpoint.
22. **Managed identity** for the endpoint and its data-plane grants.

---

## Loom coverage

Legend: ✅ built · ⚠️ honest gate (`no-vaporware.md`) · ❌ missing.

| # | Capability | Loom | Where |
|---|---|---|---|
| 1 | List endpoints + state + traffic | ✅ | Overview tab table; `listServingEndpoints()` |
| 2 | Create endpoint (name, model, version, compute, scaling) | ✅ | Deployments tab form; `createServingEndpoint()` |
| 3 | Delete endpoint | ✅ | Overview row action; `deleteServingEndpoint()` |
| 4 | Endpoint details (scoring URI, state, auth mode) | ✅ | `DetailsPanel` — name / backend / state / auth / scoring URI |
| 5 | Consume / sample code tab | ❌ | Scoring URI is shown; no generated REST/SDK snippet, no key-retrieval affordance |
| 6 | Tags / description on the endpoint | ❌ | Not surfaced in the create form or details panel |
| 7 | Add a deployment to an EXISTING endpoint | ❌ | The form creates an endpoint **with its first deployment**; there is no "add second deployment" action — which makes #13 reachable only for endpoints whose extra deployments were made outside Loom |
| 8 | Autoscale min/max; Databricks scale-to-zero | ✅ | Scaling dropdown → manual instances, or min/max; `Scale to zero when idle` switch on the Databricks backend |
| 9 | Deployment list (model, compute, scale, traffic, state) | ✅ | Deployments tab table |
| 10 | Update / delete a single deployment | ❌ | No per-deployment actions in the table |
| 11 | Deployment logs | ❌ | No log surface; a failed deployment shows only its `state` |
| 12 | Per-deployment test | ❌ | Invoke targets the ENDPOINT, so the traffic split decides which deployment answers |
| 13 | Traffic split across deployments | ✅ | `Split traffic` dialog; `setServingTraffic()` + `validateTrafficSplit()` (integers, 0-100, sums to 100) |
| 14 | Mirror / shadow traffic | ❌ | Not offered |
| 15 | Scoring console (real POST, editable JSON body) | ✅ | Invoke tab; `invokeServingEndpoint()` via `invoke/route.ts`, payload shaped by `shapeInvokePayload()` |
| 16 | Round-trip latency for the test call | ✅ | `HTTP <status>` + `<n> ms` badges — measured, not modelled |
| 17 | Key vs Entra invocation | ⚠️ | Auth MODE is displayed; the console always invokes server-side through the BFF with the Console identity. There is no key-retrieval UI (deliberate: `no-vaporware.md` / the repo's never-show-a-secret rule) |
| 18 | Latency / requests / errors metrics | ✅ | Monitoring tab tiles + `MetricChart`; real Azure Monitor `RequestLatency` / `RequestsPerMinute` split by `statusCodeClass` |
| 19 | Selectable timespan | ⚠️ | `getServingMetrics()` accepts `timespan` / `interval`, but the editor does not expose a picker — one fixed window |
| 20 | Alerts / diagnostic settings | ❌ | Not surfaced here (the estate-wide `/monitor` surface is separate) |
| 21 | Public network access / private endpoint | ❌ | Not surfaced on this item (the AI Foundry hub editor has its own networking pane) |
| 22 | Endpoint managed identity + data-plane grants | ❌ | Not surfaced |
| — | Honest gate when no backend is configured | ✅ | `servingConfigGate()` → shared `HonestGate` with an inline Fix-it (gate `svc-model-serving`), and the full surface still renders |
| — | Clean first open on a new item | ✅ | `NewItemCreateGate` — no red banner on a freshly created item (`ux-baseline` G1/G2 item 6) |

## Backend per control

| Control | Backend call |
|---|---|
| Overview list / reload | `GET /api/items/model-serving-endpoint/[id]` → `listServingEndpoints()` → AML ARM `onlineEndpoints` list (or Databricks `/serving-endpoints`) |
| Create endpoint | `POST .../[id]` → `createServingEndpoint()` → AML ARM PUT `onlineEndpoints` + `deployments` |
| Delete endpoint | `DELETE .../[id]` → `deleteServingEndpoint()` |
| Split traffic | `POST .../[id]/traffic` → `setServingTraffic()` → ARM PATCH `properties.traffic` |
| Invoke | `POST .../[id]/invoke` → `invokeServingEndpoint()` → data-plane POST to the scoring URI |
| Monitoring tiles | `GET .../[id]/metrics` → `getServingMetrics()` → `monitor-client.fetchMetrics` on `Microsoft.MachineLearningServices/workspaces/onlineEndpoints` |

No mock arrays and no `return []` placeholders on any of the six — verified by
reading `model-serving-client.ts`, which routes every call to real REST or to
`servingConfigGate()`.

---

## Cloud parity (`cloud-parity.md`)

The AML path resolves its workspace through `resolve-aml-target`, and
`model-serving-client.ts` documents the Gov data-plane host (`*.api.ml.azure.us`),
so the Azure-native default is written to work in Commercial and in Gov.
**No per-cloud receipt exists for this surface** — neither boundary has been
exercised live for it. Per `cloud-parity.md` §4 that is stated here as untested
rather than implied working.

## Grade

**C+ / B− (functional, incomplete inventory), and NOT A-grade.** Two independent
reasons, both from the rules rather than from taste:

- `ui-parity.md`: "A surface is A-grade only when its parity doc shows every
  inventory row built ✅ or honest-gate ⚠️ — zero ❌." Ten rows are ❌.
- `ux-baseline.md` G1: no in-browser E2E receipt exists for this surface, so it
  could not be graded A even with a full inventory.

What IS solid: the primary loop — list, create, split traffic, invoke, watch real
metrics — is real end-to-end against real Azure REST on the Azure-native default,
with an honest gate and a clean first open. The gaps are breadth (add-a-deployment,
logs, per-deployment test, consume snippet), not vaporware.

The largest single gap is **#7**, because it is load-bearing for #13: without an
"add a deployment to this endpoint" action, the blue/green traffic split — the
headline reason this item type exists — can only be exercised on endpoints whose
second deployment was created outside Loom.

Per #3723's acceptance ("if gaps are found, file them as their own sized issues
rather than silently noting them in the doc") the ❌ rows above are for sizing into
follow-up issues; they are recorded here so the inventory is complete, not as a
substitute for those issues.
