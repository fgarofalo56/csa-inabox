# WS-M — Inbound Migration & Adoption (the defector on-ramp)

Part of the master PRP **loom-next-level** (rev 2, pass 2 + round-2 closing
pass). Author: round-2 closing editor. Date: 2026-07-22.
Source: `temp/prp-review/round2-gaps.md` Q3 GAP-ADD (the one product gap the
final review found): the openness pillar is entirely **OUTBOUND** — N1 ("the
defector-maker") lets external engines *read* Loom tables zero-copy — but there
was **no inbound path to move an existing Snowflake / Databricks / Fabric /
Power BI estate INTO Loom**: no schema/DDL importer, no SQL/DAX/notebook
translation, no bulk table copy-in wizard, no PBIX→`code-report` converter.
EXP1 is Loom→Loom portability; N19g backfills *catalog metadata* only; N7b
brings *source DBs* via CDC. This is the on-ramp Snowflake (SnowConvert),
Databricks (migration accelerators), and Fabric (migration assistant) all
invested in to win defectors.

**Phase: 4** — a new mini-workstream riding N1/N4/N16 (master spine updated).
**Business note:** full fidelity is a multi-quarter content effort; ship **M1
(assessment) first** as the credible on-ramp, M2/M3 iterate.

> **Conventions inherited from the master PRP (binding on every M-item):**
> PR-sized with stable IDs; goal, current-state grounding, exact files,
> bicep-sync (**R0 param-cap rule** — new bicep params ride the config-object
> pattern, never a new top-level `param`), env/gates (ENV_CHECKS +
> `lib/gates/registry.ts` + Fix-it per G2; EnvSpecs carry the **X2
> `availability`** field; serialize on the env-checks/registry files),
> admin-page registration via `lib/components/admin-shell.tsx` +
> `lib/panes/admin-overview.tsx` + passing
> `lib/nav/__tests__/nav-registries.test.ts` (master ground-truth #16),
> acceptance incl. a **G1 real-data E2E receipt**, per-cloud contract, honest
> sizing. New platform services follow the existing `apps/loom-*` ACA pattern.
> Source-estate credentials are entered via connection wizards and stored via
> the existing connection/Key Vault pattern — no freeform config
> (`loom_no_freeform_config`), no secrets in env vars. Everything is
> Fabric-free on the default path (`no-fabric-dependency`): Fabric/Power BI
> here are *migration SOURCES* read via their APIs when the operator connects
> one — never a runtime dependency of Loom.

---

## M1 — Estate assessment + inventory importer

**Goal:** point Loom at a **Snowflake / Databricks-UC / Fabric-workspace /
Power-BI-workspace** estate, enumerate schemas, tables, models, notebooks,
reports; produce a **migration-readiness report** — a mapping + effort report
(what maps 1:1 to Loom item types, what needs review).

**Files:** `apps/loom-migrate` ACA reader (per the `apps/loom-*` pattern: app
dir + Dockerfile, bicep `modules/data-plane/loom-migrate-aca.bicep` wired via
the R0 config object, internal ingress + UAMI grants) + `/admin/migrate`
surface (registers via admin-shell/admin-overview; passes
`nav-registries.test.ts`) + `/api/migrate/assess` (gate-envelope +
route-toolkit per WS-R). **Reuses N19g's ingest for catalog metadata** —
extend, don't fork.

**Acceptance:** G1 — assess a real Demo Snowflake/UC estate, render the
readiness report with real object counts + a per-object 1:1/needs-review
mapping. **Per-cloud:** reader in-boundary; SaaS-source connectors
honest-gated in IL5 (Fix-it names the connection prerequisite). **Size: L.**

## M2 — Schema + data copy-in

**Goal:** bulk create Loom lakehouse/warehouse tables from the M1-assessed
schema and copy data via **ADF/Synapse pipeline (Delta landing)** — the
N7b/N7c substrate **in reverse**.

**Files:** copy-in plan builder on the M1 assessment output; pipeline
generation through the existing `adf-client`/`synapse-dev-client` paths (no
second orchestration path); progress monitor in `/admin/migrate`.

**Acceptance:** G1 — import ≥1 schema + its data from the assessed estate;
rows land in Bronze/managed Delta and read back through a Loom editor with
real counts in the receipt. **Per-cloud:** ADF/Synapse GA Commercial + Gov;
IL5 — in-boundary copy only; SaaS sources honest-gated. **Size: L.**

## M3 — Code translation (best-effort, honest)

**Goal:** **Snowflake/T-SQL → Loom SQL** and **DAX/PBIX → `code-report` (N16)
/ semantic-contract (N9)** transpile with a **"needs-review" diff — never
silent wrong output** (mirrors A1's `unsupportedDaxError` honesty).
PBIX→code-report rides N16; DAX rides the A1–A3 parser.

**Files:** transpiler modules in `apps/loom-migrate` + review-diff UI in
`/admin/migrate` (side-by-side source vs generated artifact, per-construct
supported/needs-review flags); generated artifacts land as draft Loom items
(draft/publish semantics).

**Acceptance:** G1 — translate a real report/query set from the Demo estate;
render a translated report on real rows; an unsupported construct is flagged
needs-review with the exact reason (no silent output). **Per-cloud:** reader
in-boundary; SaaS-source connectors honest-gated in IL5. **Size: XL, split**
(SQL transpile; DAX/PBIX→code-report; review-diff + draft-item landing).

---

## Ordering & serialization (mirrored in the master)

- **M1 → M2/M3** (both consume the M1 assessment).
- **M3 after N16** (the PBIX→code-report target must exist) **and after the
  A1–A3 DAX parser lands**; contract emission targets N9's store.
- Serialize with N19g (shared catalog-metadata ingest) and the env-checks/
  registry files for any new env var (X2 `availability` on every EnvSpec).
- No new ratchets — the program's ratchet inventory stays at 13.
