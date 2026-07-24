# Runbook — data observability incident (N17)

The incident console (`/admin/incident-console`) opens an incident when a table
monitor trips (freshness / volume / schema-drift) or an N7d data-quality finding
is consumed. This is the on-call procedure for triaging one.

## 1. Triage

1. Open the incident. Read the **metric** card — it names what tripped
   (`data-age-minutes` past SLA, a `row-count` z-score outlier, or a
   `schema-drift` column delta) and the baseline it was scored against.
2. Read the **downstream-impact** panel — the assets that break if this table is
   stale/wrong, resolved from the unified lineage graph (Purview/Atlas + Unity
   Catalog + Weave/OpenLineage). Prioritize by blast radius.
3. **Acknowledge** the incident (audited) so the rest of the team knows it's
   owned. Add a note with what you're checking.

## 2. Diagnose by kind

- **Freshness** — the newest data is older than the SLA. Check the producing
  pipeline/notebook (the upstream node on the impact panel): did the last run
  fail or not start? Restart it, then record a fresh observation.
- **Volume** — a row-count spike or drop vs the rolling baseline. A drop often
  means a partial/failed load (re-run the producer); a spike often means a
  double-load or an unfiltered backfill (dedupe / scope the load).
- **Schema drift** — columns were added or removed vs the prior observation.
  A *removed* column is breaking for downstream consumers — coordinate the
  contract change (N6 data contracts) before it propagates.

## 3. Resolve

- Once the underlying cause is fixed and a healthy observation is recorded, the
  monitor stops re-firing. **Resolve** the incident (audited). If the signal
  re-fires later the same incident **reopens** (deduped) rather than spawning a
  duplicate.

## 4. Notes

- Every acknowledge / resolve / reopen / note is written to the audit log and
  fanned out via the audit stream — the timeline is the authoritative record.
- Incident alerts route through the one shared action group
  (`LOOM_ALERT_ACTION_GROUP_ID`, O1 standard) — P2 for `error`, P3 for `warning`.
- The whole loop (collector + console + anomaly detection) is in-boundary; no
  external observability SaaS is contacted, so this runbook works air-gapped
  (IL5).
