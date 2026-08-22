# PRP — Geospatial, Graph & Distributed-ML capability program ("geo-graph-ml")

**Status:** BACKLOG (researched 2026-07-16; operator-requested)
**Scope:** five capability areas folded into Loom, Azure-native-first, Commercial + Gov.
**Sources researched:** Stream Analytics geospatial scenarios (Learn), ArcGIS GeoAnalytics
for Fabric Spark (Learn, GA Nov 2025), ArcGIS GeoAnalytics Engine install on Azure Synapse
(developers.arcgis.com/geoanalytics/install/azure_syn), Apache Spark GraphX
(spark.apache.org/graphx), SynapseML (microsoft.github.io/SynapseML +
github.com/microsoft/SynapseML, GA w/ enterprise support on Synapse Spark).

## Cloud-availability + licensing ground truth (drives every design choice below)

| Capability | Commercial | Gov (usgov*) | License / gate |
|---|---|---|---|
| ASA geospatial fns (CreatePoint/Polygon/LineString, ST_DISTANCE/OVERLAPS/INTERSECTS/WITHIN) | ✅ engine built-in | ✅ engine built-in (ASA GA in Gov) | none — zero gate |
| ArcGIS GeoAnalytics for **Fabric** Spark | ✅ preinstalled in Fabric runtime | ❌ (Fabric-family; opt-in only per `no-fabric-dependency`) | BYO Esri license (Marketplace); tenant-admin toggle; calls Esri auth endpoints externally |
| ArcGIS GeoAnalytics **Engine on Synapse Spark** (Azure-native DEFAULT) | ✅ jar/whl workspace packages on pool | ✅ same mechanism (Synapse GA in Gov) | BYO Esri license (username/password or API key) → **honest gate + Fix-it wizard**; Esri auth endpoint egress from VNet must be allowed |
| GraphX / **GraphFrames** on Spark | ✅ pure OSS | ✅ pure OSS | none — jar+whl install only |
| **SynapseML** | ✅ built into Synapse Spark runtime (GA, enterprise support) | ✅ same runtime | none for core (LightGBM/ONNX/SHAP); `synapse.ml.services` needs AI-service endpoint config → cloud-aware (.azure.us) via existing aoai-chat-client conventions |

Design rules honored: `no-fabric-dependency` (Synapse/ASA/ADX are the defaults; Fabric
GeoAnalytics strictly opt-in), `no-vaporware` (every surface calls the real backend or
shows an exact-remediation gate w/ G2 Fix-it), `ux-baseline`/`web3-ui` (canvas node-kit,
guided launchers, LearnPopovers), G2 zero-day-one-gates (only the Esri license is a
legitimately unavoidable BYO gate — registered in `lib/gates/registry` with a Fix-it
wizard).

---

## Wave GEO-1 — Real-time geospatial in Eventstream (ASA geospatial) — zero gate

The eventstream processor already compiles to a real ASA job (stream-analytics-client).
Add first-class geospatial **operator nodes** to the eventstream canvas:

- [ ] **Geofence node** — draw/import fences on an Azure Maps canvas (existing Maps
      enablement + map visual): polygon drawn → stored as ASA **reference data** input
      (blob-backed, the documented pattern) → compiled `JOIN ref ON ST_WITHIN(...) = 0|1`
      (inside/outside modes). Multi-fence via reference table; WKT + GeoJSON import.
- [ ] **Proximity node** — `ST_DISTANCE(a, b) < threshold` join (e.g. vehicle↔depot);
      unit picker (m/km/mi), threshold slider.
- [ ] **Geo-aggregate node** — requests-per-region: `GROUP BY region, HoppingWindow(...)`
      over `ST_WITHIN(point, fence)=1` (the documented ride-share aggregation pattern).
- [ ] **Point-builder node** — `CreatePoint(lat, lon)` mapping UI for streams that carry
      raw lat/lon columns; LineString builder for track assembly.
- [ ] **Live map output** — eventstream preview tab gains a map mode (Azure Maps) plotting
      the latest N output events + fence overlays; alert rows pulse on the map.
- [ ] **Activator wiring** — geofence-violation output → one-click "create alert" (the
      existing activator/Monitor scheduled-alert path).
- [ ] **Demo app** — "Demo — Fleet Geofencing" use-case app: seeded vehicle GPS stream
      (simulator), 3 fences, live map, violation alerts (per demo-apps pattern, REAL data).
- [ ] Parity doc `docs/fiab/parity/eventstream-geospatial.md` (vs ASA geospatial scenarios
      doc + Fabric Eventstream geo functions) + LearnPopovers on each node.

## Wave GEO-2 — ArcGIS GeoAnalytics (Esri) — Azure-native Synapse Engine default, Fabric opt-in

- [ ] **Esri package flow in the Spark **environment** editor** (spark-environment-editor
      exists): guided "Add ArcGIS GeoAnalytics Engine" wizard — upload Esri jar/whl as
      Synapse **workspace packages**, assign to pool (the documented azure_syn install),
      show install-job progress (pool package jobs cap 50 min — surface honestly).
- [ ] **License gate (G2-compliant)** — `LOOM_ARCGIS_AUTH_MODE` + KV-backed
      username/password or API key; gate registered in `lib/gates/registry` with Fix-it
      wizard (enter license → stored as Container-App secret → notebook auth snippet
      auto-injected). Unauthorized runs surface Esri's `AuthError: Not authorized`
      as the friendly gate, not a stack trace.
- [ ] **Spatial-analysis notebook template gallery** — hot spots (FindHotSpots), dwell
      locations, motion statistics, group-by-proximity, ST_* SQL function snippets
      (160+ fns), feature-service read (`spark.read.format('feature-service')`),
      geometry↔WKB round-trip guidance for Delta writes (documented consideration).
- [ ] **Map plotting of results** — `df.st.plot`-style results rendered in the notebook +
      lakehouse map tab via Azure Maps (Loom-native; no Esri basemap dependency on the
      default path).
- [ ] **Fabric opt-in flavor** — when `LOOM_SPARK_BACKEND=fabric` + bound workspace, note
      the tenant-admin toggle (Admin Portal → ArcGIS GeoAnalytics for Fabric Runtime) and
      reuse the same notebook templates; NEVER the default path.
- [ ] **Gov consideration doc** — Esri auth endpoint egress from the in-VNet Spark subnet
      (firewall rule), license portability; document in docs/fiab/geoanalytics.md.

## Wave GEO-3 — Spark graph analytics (GraphX/GraphFrames) — zero gate, all clouds

Complements the existing ADX-native graph (gql-graph): ADX = interactive graph queries;
Spark = batch graph **algorithms** over lakehouse Delta at scale.

- [ ] **GraphFrames on the pool** — bundle/install graphframes jar+whl via the environment
      editor (same workspace-package flow; version matched to the pool's Spark version).
      GraphX itself stays available to Scala users; GraphFrames is the PySpark surface.
- [ ] **Graph-analytics wizard** (Data Science hub tool or a mode on the existing graph
      item): pick vertices table + edges table from a lakehouse (src/dst/relationship
      column mapping) → pick algorithm — PageRank, connected components, triangle count,
      shortest paths, label propagation, motif finding — → run as Spark job → results
      written back to Delta (`Tables/graph_<algo>_<ts>`).
- [ ] **Visualize** — results overlay on the existing graph canvas (top-N subgraph) +
      table preview; "open in notebook" escape hatch generating the equivalent
      GraphFrames code.
- [ ] **Templates** — notebook gallery: fraud-ring detection (connected components),
      influence ranking (PageRank), network motifs; seeded demo dataset.
- [ ] Parity/positioning doc: when to use gql-graph (ADX) vs Spark graph (batch) —
      docs/fiab/graph-analytics.md.

## Wave GEO-4 — SynapseML distributed ML — zero gate core, cloud-aware AI services

SynapseML ships IN the Synapse Spark runtime (GA + enterprise support) — no install gate.

- [ ] **Version/runtime matrix check** — surface the pool's SynapseML version in the
      environment editor; optional `%%configure` pin snippet for a newer release
      (spark.jars.packages + repositories + classpath-first, per the documented pattern).
- [ ] **Distributed-ML template gallery** (Data Science hub): LightGBM train/tune at
      scale, ONNX batch inference (import any ONNX model from ml-model item → distributed
      scoring over lakehouse), SHAP/LIME explainability run (writes explanations to
      Delta), Conditional KNN, Vowpal Wabbit text.
- [ ] **AI-services enrichment at Spark scale** — `synapse.ml.services` wired to Loom's
      existing AOAI + AI-services config (aoai-chat-client conventions, cloud-aware
      endpoints incl. .azure.us): batch sentiment/translation/OCR/embedding/LLM-prompt
      over lakehouse tables. Extend the existing AI-enrichment surface with a
      "Spark-scale" engine option for large tables (current path is row-by-row).
- [ ] **AutoML bridge** — LightGBM results register into the existing ml-model item
      (metrics, artifact, ONNX export) so serving/scoring reuse the current story.
- [ ] **Explainability tab on ml-model** — render stored SHAP summaries (responsible-AI
      panel; ICE/PDP later).
- [ ] Docs + LearnPopovers + demo app ("Demo — Distributed ML on Lakehouse").

## Cross-cutting (all waves)

- [ ] Bicep sync: nothing new for GEO-1/3/4 (existing ASA/Synapse/Maps infra); GEO-2 adds
      only KV secrets + optional firewall rule — document per no-vaporware §bicep.
- [ ] Gate registry entries + Admin gate page rows for: Esri license (GEO-2 only).
- [ ] Catalog/Create cards + branded item-type visuals (item-type-visual registry) for any
      new tool entries; guided EmptyStates; §7 checklist per surface.
- [ ] Browser E2E receipts per wave (G1) incl. Gov pass for GEO-1/3/4.

## Suggested order & sizing

GEO-1 (highest wow/zero gate, builds on eventstream+Maps: ~1 wave) → GEO-4 (zero gate,
big data-science value: ~1 wave) → GEO-3 (small: ~half wave) → GEO-2 (BYO-license,
operator must supply Esri credentials to E2E the authorized path: ~1 wave + operator input).
