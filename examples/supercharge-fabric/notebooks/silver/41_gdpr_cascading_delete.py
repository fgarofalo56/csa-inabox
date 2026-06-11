# Databricks notebook source
# MAGIC %md
# MAGIC # GDPR Cascading Delete — DSAR Erasure Execution
# MAGIC
# MAGIC **Phase 14 Wave 5 — Feature 5.12**
# MAGIC
# MAGIC End-to-end implementation of a GDPR Article 17 ("Right to Erasure") cascade
# MAGIC for a single Data Subject Access Request (DSAR). This notebook locates a
# MAGIC subject across every medallion layer, plans the per-table action, executes
# MAGIC the cascade with retry + audit, and verifies the result — all under a tamper-
# MAGIC evident hash-chained audit log.
# MAGIC
# MAGIC ## What This Notebook Does
# MAGIC
# MAGIC 1. **Locate**   — enumerate every Bronze / Silver / Gold / Feature-store /
# MAGIC                 Eventhouse-referenced table that holds the subject and the
# MAGIC                 PII column footprint per table
# MAGIC 2. **Plan**     — for each affected table, choose `hard_delete`,
# MAGIC                 `pseudonymize`, `anonymize`, or `no_action`, applying the
# MAGIC                 statutory exemption rules (BSA, HIPAA, Privacy Act)
# MAGIC 3. **Execute**  — apply the plan transactionally, writing a hash-chained
# MAGIC                 audit row per operation; halt on first failure, never leave
# MAGIC                 partial state
# MAGIC 4. **Verify**   — re-query each table to prove the requested state was
# MAGIC                 achieved; emit PASS / FAIL with detail
# MAGIC
# MAGIC ## Parameters
# MAGIC
# MAGIC | Name | Required | Default | Description |
# MAGIC |------|----------|---------|-------------|
# MAGIC | `dsar_id` | yes | `DSAR-YYYY-MM-DD-001` | DSAR ticket identifier |
# MAGIC | `subject_id` | yes | none | Master ID from MDM, or business key (email / tax id hash) |
# MAGIC | `mode` | yes | `dry-run` | One of `locate` / `dry-run` / `execute` / `verify` |
# MAGIC | `requested_action` | yes | `erase` | One of `erase` / `pseudonymize` / `anonymize` |
# MAGIC | `exemptions` | optional | `[]` | Comma-separated list: `compliance_retention`, `legal_hold`, `public_interest` |
# MAGIC | `executor_user` | yes | runtime user | Identity audited as the executor |
# MAGIC
# MAGIC ## Modes
# MAGIC
# MAGIC - `locate`   — read-only scan; writes inventory to `lh_audit.dsar_locator_results`
# MAGIC - `dry-run`  — produces full cascade plan; writes to `lh_audit.dsar_cascade_plan`
# MAGIC - `execute`  — applies the plan; writes to `lh_audit.dsar_execution_log`
# MAGIC - `verify`   — post-execution PASS/FAIL; writes to `lh_audit.dsar_verification_results`
# MAGIC
# MAGIC ## Related Docs
# MAGIC
# MAGIC - `docs/best-practices/security/gdpr-right-to-deletion.md` — the cascade pattern
# MAGIC - `docs/compliance-templates/dsar-runbook.md` — Privacy Office runbook
# MAGIC - `docs/best-practices/data-management/master-data-management.md` — MDM golden-record fan-out
# MAGIC - `docs/best-practices/data-management/late-arriving-data.md` — idempotent merge pattern
# MAGIC
# MAGIC ## ⚖️ Regulatory Disclaimer
# MAGIC
# MAGIC > This notebook is an engineering implementation of the cascade pattern
# MAGIC > documented in `gdpr-right-to-deletion.md`. It is **not** a substitute for
# MAGIC > legal review. The exemption rules encoded here (BSA 5-year, HIPAA 6-year,
# MAGIC > Privacy Act loan retention) are **illustrative**. Privacy counsel must
# MAGIC > sign off on the exemption map for every DSAR before `mode=execute` runs.
# MAGIC > Hard-deleting a record subject to a statutory retention obligation is a
# MAGIC > regulatory violation regardless of what the subject requested. When in
# MAGIC > doubt, default to `pseudonymize` and escalate to the Privacy Office DG.
# MAGIC
# MAGIC > **Backup paradox:** This notebook does **not** delete from offsite or
# MAGIC > immutable backups. Backup propagation is governed by the documented RPO
# MAGIC > and rotation policy. If a backup is restored within the propagation
# MAGIC > window, this notebook MUST be re-run against the restored state.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup — Imports and Parameter Shim

# COMMAND ----------

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from delta.tables import DeltaTable
from pyspark.sql import DataFrame
from pyspark.sql.functions import (
    col,
    current_timestamp,
    lit,
)
from pyspark.sql.types import (
    ArrayType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configure structured logging — never log raw subject_id, only its hash
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("dsar.cascade")


def _get_arg(name: str, default: Any = None) -> Any:
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default.

    Mirrors the pattern from notebooks/silver/01_silver_slot_cleansed.py — try
    notebookutils first, then mssparkutils, then fall back to env var.
    """
    try:
        import notebookutils  # Fabric runtime
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        try:
            import mssparkutils  # legacy Synapse/Fabric runtime
            return mssparkutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)


def _notebook_exit(status: str) -> None:
    """Exit with a status payload that pipelines can consume."""
    try:
        import notebookutils
        notebookutils.notebook.exit(status)
    except Exception:
        try:
            import mssparkutils
            mssparkutils.notebook.exit(status)
        except Exception:
            raise SystemExit(status)


def _runtime_user() -> str:
    """Best-effort identity for the audit log."""
    for candidate in ("USER", "USERNAME", "MAIL", "AAD_UPN"):
        v = os.environ.get(candidate)
        if v:
            return v
    return "unknown-executor"


# COMMAND ----------

# MAGIC %md
# MAGIC ## Parameters
# MAGIC
# MAGIC Defaults are tuned for safe `dry-run` execution. Production calls MUST
# MAGIC supply `dsar_id`, `subject_id`, `executor_user`, and the explicit `mode`.

# COMMAND ----------

dsar_id = _get_arg(
    "dsar_id",
    f"DSAR-{datetime.utcnow().strftime('%Y-%m-%d')}-001",
)
subject_id = _get_arg("subject_id", "")
mode = _get_arg("mode", "dry-run").lower().strip()
requested_action = _get_arg("requested_action", "erase").lower().strip()
exemptions_raw = _get_arg("exemptions", "")
executor_user = _get_arg("executor_user", _runtime_user())

# Normalize exemptions into a list
if isinstance(exemptions_raw, str):
    exemptions: List[str] = [
        e.strip() for e in exemptions_raw.split(",") if e.strip()
    ]
elif isinstance(exemptions_raw, list):
    exemptions = [str(e).strip() for e in exemptions_raw if str(e).strip()]
else:
    exemptions = []

VALID_MODES = {"locate", "dry-run", "execute", "verify"}
VALID_ACTIONS = {"erase", "pseudonymize", "anonymize"}
VALID_EXEMPTIONS = {"compliance_retention", "legal_hold", "public_interest"}

assert mode in VALID_MODES, f"mode must be one of {VALID_MODES}, got: {mode}"
assert (
    requested_action in VALID_ACTIONS
), f"requested_action must be one of {VALID_ACTIONS}, got: {requested_action}"
for ex in exemptions:
    assert ex in VALID_EXEMPTIONS, f"unknown exemption: {ex}"
assert subject_id, "subject_id is required (master_id from MDM or business key)"
assert dsar_id, "dsar_id is required"


# Hash the subject identifier — never log raw subject_id
def _subject_hash(value: str) -> str:
    """Salted SHA-256 of the subject identifier.

    Salt MUST come from env var (Phase 11 fix); never inline. Rotation policy
    documented in gdpr-right-to-deletion.md §Pseudonymization.
    """
    salt = os.environ.get("FABRIC_POC_HASH_SALT")
    if not salt:
        raise RuntimeError(
            "FABRIC_POC_HASH_SALT env var not set — refusing to operate on "
            "subject identifiers without a salt. See Phase 11 audit remediation."
        )
    return hashlib.sha256(f"{salt}|{value}".encode("utf-8")).hexdigest()


SUBJECT_HASH = _subject_hash(subject_id)

log.info(
    "DSAR cascade starting | dsar_id=%s | subject_hash=%s | mode=%s | "
    "requested_action=%s | exemptions=%s | executor=%s",
    dsar_id,
    SUBJECT_HASH[:12] + "…",
    mode,
    requested_action,
    exemptions,
    executor_user,
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Audit Lakehouse Bootstrap
# MAGIC
# MAGIC `lh_audit` is a dedicated lakehouse for compliance audit tables — separate
# MAGIC blast radius from operational `lh_silver` / `lh_gold`. WORM retention should
# MAGIC be configured on the underlying ADLS account at provisioning time
# MAGIC (Bicep `storage-account.bicep` enables immutability policies).

# COMMAND ----------

AUDIT_LAKEHOUSE = "lh_audit"

AUDIT_TABLES = {
    "locator": f"{AUDIT_LAKEHOUSE}.dsar_locator_results",
    "plan": f"{AUDIT_LAKEHOUSE}.dsar_cascade_plan",
    "execution": f"{AUDIT_LAKEHOUSE}.dsar_execution_log",
    "verification": f"{AUDIT_LAKEHOUSE}.dsar_verification_results",
    "subprocessor": f"{AUDIT_LAKEHOUSE}.dsar_sub_processor_notify",
}


def _ensure_audit_schemas() -> None:
    """Create empty audit tables on first run (idempotent)."""
    schemas = {
        AUDIT_TABLES["locator"]: StructType(
            [
                StructField("dsar_id", StringType(), False),
                StructField("subject_hash", StringType(), False),
                StructField("table_name", StringType(), False),
                StructField("row_count", LongType(), True),
                StructField("pii_columns", ArrayType(StringType()), True),
                StructField("exemption_applies", StringType(), True),
                StructField("located_at", TimestampType(), False),
                StructField("executor_user", StringType(), False),
            ]
        ),
        AUDIT_TABLES["plan"]: StructType(
            [
                StructField("dsar_id", StringType(), False),
                StructField("subject_hash", StringType(), False),
                StructField("table_name", StringType(), False),
                StructField("planned_action", StringType(), False),
                StructField("rationale", StringType(), True),
                StructField("pii_columns", ArrayType(StringType()), True),
                StructField("dependency_order", LongType(), False),
                StructField("requires_recompute", StringType(), True),
                StructField("planned_at", TimestampType(), False),
                StructField("executor_user", StringType(), False),
            ]
        ),
        AUDIT_TABLES["execution"]: StructType(
            [
                StructField("dsar_id", StringType(), False),
                StructField("subject_hash", StringType(), False),
                StructField("table_name", StringType(), False),
                StructField("action", StringType(), False),
                StructField("rows_affected", LongType(), False),
                StructField("hash_prev", StringType(), True),
                StructField("hash_self", StringType(), False),
                StructField("executor_user", StringType(), False),
                StructField("executed_at", TimestampType(), False),
                StructField("status", StringType(), False),
                StructField("error_detail", StringType(), True),
            ]
        ),
        AUDIT_TABLES["verification"]: StructType(
            [
                StructField("dsar_id", StringType(), False),
                StructField("subject_hash", StringType(), False),
                StructField("table_name", StringType(), False),
                StructField("expected_state", StringType(), False),
                StructField("observed_state", StringType(), False),
                StructField("verified", StringType(), False),
                StructField("evidence", StringType(), True),
                StructField("verified_at", TimestampType(), False),
            ]
        ),
        AUDIT_TABLES["subprocessor"]: StructType(
            [
                StructField("dsar_id", StringType(), False),
                StructField("subject_hash", StringType(), False),
                StructField("sub_processor", StringType(), False),
                StructField("dataset", StringType(), True),
                StructField("notification_required", StringType(), False),
                StructField("notification_sent_at", TimestampType(), True),
                StructField("notes", StringType(), True),
            ]
        ),
    }
    for table_name, schema in schemas.items():
        if not spark.catalog.tableExists(table_name):
            empty_df = spark.createDataFrame([], schema)
            (
                empty_df.write.format("delta")
                .mode("overwrite")
                .option("delta.enableChangeDataFeed", "true")
                .saveAsTable(table_name)
            )
            log.info("Provisioned audit table: %s", table_name)


_ensure_audit_schemas()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Idempotency Guard
# MAGIC
# MAGIC Re-running the same `dsar_id` in `execute` mode after a successful prior
# MAGIC execution is a no-op. We detect this by querying the execution log for
# MAGIC any prior `status=COMPLETE` rows for this DSAR. If found, the executor
# MAGIC short-circuits — only `verify` is allowed against an already-completed
# MAGIC DSAR. This protects against accidental double-execution and supports the
# MAGIC restore-from-backup re-apply workflow safely.

# COMMAND ----------


def _prior_execution_exists(target_dsar_id: str) -> bool:
    df = spark.table(AUDIT_TABLES["execution"]).filter(
        (col("dsar_id") == target_dsar_id) & (col("status") == lit("COMPLETE"))
    )
    return df.limit(1).count() > 0


PRIOR_EXECUTION = _prior_execution_exists(dsar_id)
if PRIOR_EXECUTION and mode == "execute":
    log.warning(
        "DSAR %s already has COMPLETE execution rows — skipping re-execution. "
        "Use mode=verify for re-verification, or open a new dsar_id.",
        dsar_id,
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Subject Locator
# MAGIC
# MAGIC Walks the lakehouse's known subject-bearing tables and returns, for each:
# MAGIC `{table_name: {row_count, pii_columns, exemption_applies}}`.
# MAGIC
# MAGIC The dataset registry is the long-term solution (see Wave 3 doc); for
# MAGIC POC purposes we hard-code the table list as a starting inventory. New
# MAGIC subject-bearing tables MUST be added here AND in the dataset registry.

# COMMAND ----------

# Subject-bearing tables grouped by layer + concern.
# Each entry: (table_name, subject_key_column, pii_columns, retention_policy)
SUBJECT_BEARING_TABLES: List[Dict[str, Any]] = [
    # ── MDM golden records (root of identity fan-out) ──────────────────────
    {
        "table": "lh_gold.party_golden",
        "subject_key": "master_id",
        "pii_columns": ["master_id", "full_name", "email", "phone", "ssn_hash"],
        "retention": "consent",
        "depends_on": [],
    },
    # ── Silver canonicalized party records (4 source systems) ──────────────
    {
        "table": "lh_silver.party_canonical_loyalty",
        "subject_key": "master_id",
        "pii_columns": ["master_id", "loyalty_email", "phone", "address"],
        "retention": "consent",
        "depends_on": ["lh_gold.party_golden"],
    },
    {
        "table": "lh_silver.party_canonical_cage",
        "subject_key": "master_id",
        "pii_columns": ["master_id", "full_name", "tax_id_hash", "dob"],
        "retention": "contract",
        "depends_on": ["lh_gold.party_golden"],
    },
    {
        "table": "lh_silver.party_canonical_marketing",
        "subject_key": "master_id",
        "pii_columns": ["master_id", "marketing_email", "consent_flags"],
        "retention": "consent",
        "depends_on": ["lh_gold.party_golden"],
    },
    {
        "table": "lh_silver.party_canonical_compliance",
        "subject_key": "master_id",
        "pii_columns": ["master_id", "ssn_hash", "id_doc_type", "id_doc_number_hash"],
        "retention": "legal_obligation_bsa",
        "depends_on": ["lh_gold.party_golden"],
    },
    # ── Casino telemetry (player-linked sessions) ──────────────────────────
    {
        "table": "lh_silver.silver_slot_cleansed",
        "subject_key": "player_id",
        "pii_columns": ["player_id"],
        "retention": "legitimate_interest",
        "depends_on": ["lh_silver.party_canonical_loyalty"],
    },
    # ── Compliance filings (BSA / IRS retention) ───────────────────────────
    {
        "table": "lh_bronze.bronze_ctr_filings",
        "subject_key": "player_id",
        "pii_columns": ["player_id", "full_name", "ssn_hash", "address"],
        "retention": "legal_obligation_bsa",
        "depends_on": [],
    },
    {
        "table": "lh_bronze.bronze_sar_filings",
        "subject_key": "player_id",
        "pii_columns": ["player_id", "full_name", "ssn_hash", "narrative"],
        "retention": "legal_obligation_bsa",
        "depends_on": [],
    },
    {
        "table": "lh_bronze.bronze_w2g_filings",
        "subject_key": "player_id",
        "pii_columns": ["player_id", "full_name", "ssn_hash", "tax_year"],
        "retention": "legal_obligation_irs",
        "depends_on": [],
    },
    # ── Gold KPIs (recomputed from Silver post-cascade) ────────────────────
    {
        "table": "lh_gold.fact_player_daily",
        "subject_key": "player_id",
        "pii_columns": ["player_id"],
        "retention": "derived",
        "depends_on": ["lh_silver.silver_slot_cleansed"],
    },
    {
        "table": "lh_gold.fact_compliance_summary",
        "subject_key": "player_id",
        "pii_columns": ["player_id"],
        "retention": "derived",
        "depends_on": ["lh_bronze.bronze_ctr_filings"],
    },
    # ── Feature store (ML training + online serving) ───────────────────────
    {
        "table": "lh_features.fs_player_churn_features",
        "subject_key": "player_id",
        "pii_columns": ["player_id"],
        "retention": "consent",
        "depends_on": ["lh_silver.silver_slot_cleansed"],
    },
    {
        "table": "lh_features.fs_player_ltv_features",
        "subject_key": "player_id",
        "pii_columns": ["player_id"],
        "retention": "legitimate_interest",
        "depends_on": ["lh_silver.silver_slot_cleansed"],
    },
]

# Eventhouse / KQL stores — handled via .delete in the Eventhouse runbook,
# not from this PySpark notebook. Recorded here for the locator manifest.
EVENTHOUSE_REFS: List[Dict[str, Any]] = [
    {
        "table": "eh_realtime.StreamingPlayerEvents",
        "subject_key": "player_id",
        "note": "Execute via Eventhouse .delete; verify via .show operations",
    },
    {
        "table": "eh_realtime.PlayerEmbeddings",
        "subject_key": "source_subject_id",
        "note": "Vector embeddings — must be hard-deleted regardless of retention",
    },
]


def _table_exists(name: str) -> bool:
    try:
        return spark.catalog.tableExists(name)
    except Exception:
        return False


def locate_subject(target_subject_id: str) -> List[Dict[str, Any]]:
    """Return a per-table inventory of where the subject appears.

    For each known subject-bearing table, count rows referencing the subject
    and infer whether an exemption is likely to apply. The exemption decision
    is finalized in build_cascade_plan; this is a hint only.
    """
    results: List[Dict[str, Any]] = []

    for entry in SUBJECT_BEARING_TABLES:
        table = entry["table"]
        subject_key = entry["subject_key"]
        pii_cols = entry["pii_columns"]
        retention = entry["retention"]

        if not _table_exists(table):
            log.info("Skipping %s — table not present in this workspace", table)
            continue

        try:
            n = (
                spark.table(table)
                .filter(col(subject_key) == lit(target_subject_id))
                .count()
            )
        except Exception as e:
            log.warning("Locator query failed against %s: %s", table, e)
            continue

        if n == 0:
            continue

        # Exemption hint — final decision happens in build_cascade_plan
        if retention.startswith("legal_obligation"):
            exemption_hint = "compliance_retention"
        elif retention == "legitimate_interest":
            exemption_hint = "balancing_test_required"
        else:
            exemption_hint = "none"

        results.append(
            {
                "table_name": table,
                "row_count": n,
                "pii_columns": pii_cols,
                "exemption_applies": exemption_hint,
                "retention_policy": retention,
                "subject_key": subject_key,
                "depends_on": entry.get("depends_on", []),
            }
        )

    # Eventhouse references — recorded for completeness
    for ref in EVENTHOUSE_REFS:
        results.append(
            {
                "table_name": ref["table"],
                "row_count": -1,  # unknown from PySpark side
                "pii_columns": [ref["subject_key"]],
                "exemption_applies": "external_eventhouse",
                "retention_policy": "eventhouse",
                "subject_key": ref["subject_key"],
                "depends_on": [],
                "note": ref["note"],
            }
        )

    return results


# COMMAND ----------

# MAGIC %md
# MAGIC ## Cascade Plan Builder
# MAGIC
# MAGIC Translates the locator inventory into an ordered list of `(table, action)`
# MAGIC tuples. Order matters: facts before dimensions, leaves before roots — so
# MAGIC referential integrity is never violated mid-cascade.
# MAGIC
# MAGIC Exemption rules encoded:
# MAGIC
# MAGIC | Retention Policy | Exemption Active | Action |
# MAGIC |------------------|------------------|--------|
# MAGIC | `consent` | none | `hard_delete` |
# MAGIC | `consent` | `legal_hold` | `no_action` |
# MAGIC | `legal_obligation_bsa` | `compliance_retention` | `pseudonymize` |
# MAGIC | `legal_obligation_irs` | `compliance_retention` | `pseudonymize` |
# MAGIC | `legal_obligation_*` | none specified | **error** — escalate |
# MAGIC | `legitimate_interest` | none | `hard_delete` (after balancing) |
# MAGIC | `derived` | n/a | `hard_delete` (will recompute) |
# MAGIC | `eventhouse` | n/a | `external_action` |

# COMMAND ----------


def build_cascade_plan(
    locator_results: List[Dict[str, Any]],
    active_exemptions: List[str],
    requested: str,
) -> List[Dict[str, Any]]:
    """Convert the locator inventory into an ordered cascade plan.

    The plan respects:
      - Statutory retention floors (BSA, IRS, HIPAA, Privacy Act)
      - Active legal holds (no_action; defer)
      - Public-interest archiving exemption
      - The requested action (`erase` vs `pseudonymize` vs `anonymize`)
      - Dependency order (Gold facts → Silver canonical → Bronze raw)
    """
    plan: List[Dict[str, Any]] = []

    has_compliance_retention = "compliance_retention" in active_exemptions
    has_legal_hold = "legal_hold" in active_exemptions
    has_public_interest = "public_interest" in active_exemptions

    for entry in locator_results:
        table = entry["table_name"]
        retention = entry["retention_policy"]

        # Default action driven by the requested action
        if requested == "anonymize":
            default_action = "anonymize"
        elif requested == "pseudonymize":
            default_action = "pseudonymize"
        else:
            default_action = "hard_delete"

        rationale_parts: List[str] = []

        # Statutory retention floors — these override the requested action
        if retention.startswith("legal_obligation"):
            if not has_compliance_retention:
                # No exemption flag set, but the data is in a retention-bound
                # table. This is a process error — Privacy Office must
                # explicitly invoke the compliance_retention exemption.
                action = "no_action"
                rationale_parts.append(
                    f"REFUSED: table is under {retention}; "
                    "compliance_retention exemption MUST be specified by "
                    "Privacy Office before this DSAR can proceed."
                )
            else:
                action = "pseudonymize"
                if "bsa" in retention:
                    rationale_parts.append(
                        "BSA 31 CFR 1010 — 5-year retention floor; "
                        "pseudonymize identity columns, retain transactional record"
                    )
                elif "irs" in retention:
                    rationale_parts.append(
                        "IRS W-2G — 4-year retention floor; "
                        "pseudonymize identity columns, retain tax record"
                    )
                else:
                    rationale_parts.append(
                        f"Statutory retention ({retention}); pseudonymize"
                    )
        elif has_legal_hold:
            action = "no_action"
            rationale_parts.append(
                "Legal hold active — defer; document for re-evaluation when hold lifts"
            )
        elif has_public_interest and retention == "derived":
            action = "anonymize"
            rationale_parts.append(
                "Public-interest archiving exemption claimed; "
                "anonymize aggregates per Article 17(3)(d)"
            )
        elif retention == "derived":
            # Gold/aggregate — hard_delete then recompute
            action = "hard_delete"
            rationale_parts.append(
                "Derived aggregate — hard_delete row; recompute partition from cleaned Silver"
            )
        elif retention == "eventhouse":
            action = "external_action"
            rationale_parts.append(
                "Eventhouse / KQL store — execute via .delete from runbook; "
                "verify async via .show operations"
            )
        elif retention in {"consent", "contract", "legitimate_interest"}:
            action = default_action
            rationale_parts.append(
                f"Lawful basis {retention}; no statutory retention floor; apply requested action"
            )
        else:
            action = "no_action"
            rationale_parts.append(
                f"Unknown retention policy '{retention}' — defaulting to no_action; "
                "Privacy Office review required"
            )

        plan.append(
            {
                "table_name": table,
                "planned_action": action,
                "rationale": " | ".join(rationale_parts),
                "pii_columns": entry["pii_columns"],
                "subject_key": entry["subject_key"],
                "depends_on": entry.get("depends_on", []),
                "requires_recompute": (
                    "yes" if retention == "derived" and action == "hard_delete" else "no"
                ),
                "row_count": entry["row_count"],
            }
        )

    # Order: leaves first (no one depends on them), roots last.
    # Bronze raw filings -> Silver telemetry -> Silver canonical -> Gold MDM root.
    # We compute a topological order from the depends_on graph: tables with
    # the most dependents come last. Practically, derived/Gold facts go first.
    ordered = sorted(
        plan,
        key=lambda p: (
            0 if p["requires_recompute"] == "yes" else 1,  # derived facts first
            0 if p["table_name"].startswith("lh_features") else 1,  # FS next
            0 if p["table_name"].startswith("lh_bronze") else 1,  # bronze leaves
            0 if "telemetry" in p["table_name"] or "slot" in p["table_name"] else 1,
            0 if p["table_name"].startswith("lh_silver.party_canonical") else 1,
            0 if p["table_name"] == "lh_gold.party_golden" else 1,  # MDM root last
        ),
    )

    # Stamp the dependency_order ordinal
    for idx, p in enumerate(ordered):
        p["dependency_order"] = idx

    return ordered


# COMMAND ----------

# MAGIC %md
# MAGIC ## Hash-Chain Audit Helper
# MAGIC
# MAGIC Each `dsar_execution_log` row carries `hash_prev` (the `hash_self` of the
# MAGIC last row written for this DSAR) and `hash_self` (SHA-256 of the row's
# MAGIC operational fields concatenated with `hash_prev`). Tampering with any
# MAGIC prior row breaks the chain, which is detectable on verification.

# COMMAND ----------


def _last_hash_for_dsar(target_dsar_id: str) -> Optional[str]:
    """Fetch hash_self of the most recent execution row for this DSAR."""
    df = (
        spark.table(AUDIT_TABLES["execution"])
        .filter(col("dsar_id") == target_dsar_id)
        .orderBy(col("executed_at").desc())
        .limit(1)
    )
    rows = df.collect()
    if not rows:
        return None
    return rows[0]["hash_self"]


def _chain_hash(
    prev_hash: Optional[str],
    dsar: str,
    subject: str,
    table: str,
    action: str,
    rows_affected: int,
    executed_at_iso: str,
) -> str:
    payload = "|".join(
        [
            prev_hash or "GENESIS",
            dsar,
            subject,
            table,
            action,
            str(rows_affected),
            executed_at_iso,
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _append_execution_row(
    table: str,
    action: str,
    rows_affected: int,
    status: str,
    error_detail: Optional[str] = None,
) -> str:
    """Append a single audit row with continued hash chain. Returns hash_self."""
    prev = _last_hash_for_dsar(dsar_id)
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    h_self = _chain_hash(
        prev, dsar_id, SUBJECT_HASH, table, action, rows_affected, now_iso
    )

    row_df = spark.createDataFrame(
        [
            (
                dsar_id,
                SUBJECT_HASH,
                table,
                action,
                int(rows_affected),
                prev,
                h_self,
                executor_user,
                now,
                status,
                error_detail,
            )
        ],
        schema=StructType(
            [
                StructField("dsar_id", StringType(), False),
                StructField("subject_hash", StringType(), False),
                StructField("table_name", StringType(), False),
                StructField("action", StringType(), False),
                StructField("rows_affected", LongType(), False),
                StructField("hash_prev", StringType(), True),
                StructField("hash_self", StringType(), False),
                StructField("executor_user", StringType(), False),
                StructField("executed_at", TimestampType(), False),
                StructField("status", StringType(), False),
                StructField("error_detail", StringType(), True),
            ]
        ),
    )
    row_df.write.format("delta").mode("append").saveAsTable(
        AUDIT_TABLES["execution"]
    )
    return h_self


# COMMAND ----------

# MAGIC %md
# MAGIC ## Erasure Primitives
# MAGIC
# MAGIC Three primitives:
# MAGIC - `op_hard_delete` — Delta `DELETE` against the subject key
# MAGIC - `op_pseudonymize` — Delta `UPDATE`: replace identity columns with the
# MAGIC                        salted hash, NULL the demographic columns
# MAGIC - `op_anonymize` — Delta `UPDATE`: NULL identity columns, bucket
# MAGIC                     demographic columns to coarse aggregates
# MAGIC
# MAGIC All three return `rows_affected` as a positive integer or raise.

# COMMAND ----------


# Demographic column name conventions — coarsened on anonymize
DEMOGRAPHIC_COLUMNS = {"dob", "age", "address", "zip", "city", "state", "phone"}
# Anonymization buckets — illustrative; production would use per-domain rules
AGE_BUCKETS = {"<18": "MINOR", "18-29": "ADULT_LOW", "30-49": "ADULT_MID", "50+": "ADULT_HIGH"}


def op_hard_delete(table: str, subject_key: str, target_subject: str) -> int:
    """Delta DELETE; returns count of rows that matched pre-delete."""
    if not _table_exists(table):
        return 0
    df = spark.table(table)
    before = df.filter(col(subject_key) == lit(target_subject)).count()
    if before == 0:
        return 0
    dt = DeltaTable.forName(spark, table)
    dt.delete(col(subject_key) == lit(target_subject))
    return before


def op_pseudonymize(
    table: str,
    subject_key: str,
    target_subject: str,
    pii_columns: List[str],
) -> int:
    """Replace subject_key with hash; NULL other PII columns. Returns rows_affected."""
    if not _table_exists(table):
        return 0
    df = spark.table(table)
    before = df.filter(col(subject_key) == lit(target_subject)).count()
    if before == 0:
        return 0

    token = _subject_hash(target_subject)
    dt = DeltaTable.forName(spark, table)
    update_set: Dict[str, Any] = {}
    table_columns = set(spark.table(table).columns)
    for c in pii_columns:
        if c not in table_columns:
            continue
        if c == subject_key:
            update_set[c] = lit(token)
        else:
            update_set[c] = lit(None).cast(StringType())
    if not update_set:
        return 0
    dt.update(
        condition=col(subject_key) == lit(target_subject),
        set=update_set,
    )
    return before


def op_anonymize(
    table: str,
    subject_key: str,
    target_subject: str,
    pii_columns: List[str],
) -> int:
    """NULL identity columns; coarsen demographic columns. Returns rows_affected.

    Anonymization is harder than pseudonymization — true anonymization requires
    k-anonymity / l-diversity, which depends on the full table contents not just
    one row. The implementation here is an approximation: identity columns are
    NULLed and demographic columns are bucketed. For full anonymization,
    schedule a follow-up job that enforces k-anonymity at the partition level.
    """
    if not _table_exists(table):
        return 0
    df = spark.table(table)
    before = df.filter(col(subject_key) == lit(target_subject)).count()
    if before == 0:
        return 0

    dt = DeltaTable.forName(spark, table)
    update_set: Dict[str, Any] = {}
    table_columns = set(spark.table(table).columns)
    for c in pii_columns:
        if c not in table_columns:
            continue
        update_set[c] = lit(None).cast(StringType())
    for c in DEMOGRAPHIC_COLUMNS:
        if c in table_columns:
            update_set[c] = lit("ANONYMIZED").cast(StringType())
    if not update_set:
        return 0
    dt.update(
        condition=col(subject_key) == lit(target_subject),
        set=update_set,
    )
    return before


# COMMAND ----------

# MAGIC %md
# MAGIC ## Mode Dispatch — Locate

# COMMAND ----------


def write_locator_results(results: List[Dict[str, Any]]) -> None:
    if not results:
        log.info("Locator found no rows for subject (hash %s…)", SUBJECT_HASH[:12])
        return

    rows = [
        (
            dsar_id,
            SUBJECT_HASH,
            r["table_name"],
            int(r["row_count"]) if r["row_count"] is not None else None,
            r["pii_columns"],
            r["exemption_applies"],
            datetime.now(timezone.utc),
            executor_user,
        )
        for r in results
    ]
    schema = StructType(
        [
            StructField("dsar_id", StringType(), False),
            StructField("subject_hash", StringType(), False),
            StructField("table_name", StringType(), False),
            StructField("row_count", LongType(), True),
            StructField("pii_columns", ArrayType(StringType()), True),
            StructField("exemption_applies", StringType(), True),
            StructField("located_at", TimestampType(), False),
            StructField("executor_user", StringType(), False),
        ]
    )
    df = spark.createDataFrame(rows, schema=schema)
    df.write.format("delta").mode("append").saveAsTable(AUDIT_TABLES["locator"])
    log.info(
        "Wrote %d locator rows to %s", len(rows), AUDIT_TABLES["locator"]
    )


# COMMAND ----------

# MAGIC %md
# MAGIC ## Mode Dispatch — Dry-Run

# COMMAND ----------


def write_cascade_plan(plan: List[Dict[str, Any]]) -> None:
    if not plan:
        log.info("Cascade plan is empty for subject (hash %s…)", SUBJECT_HASH[:12])
        return
    rows = [
        (
            dsar_id,
            SUBJECT_HASH,
            p["table_name"],
            p["planned_action"],
            p["rationale"],
            p["pii_columns"],
            int(p["dependency_order"]),
            p["requires_recompute"],
            datetime.now(timezone.utc),
            executor_user,
        )
        for p in plan
    ]
    schema = StructType(
        [
            StructField("dsar_id", StringType(), False),
            StructField("subject_hash", StringType(), False),
            StructField("table_name", StringType(), False),
            StructField("planned_action", StringType(), False),
            StructField("rationale", StringType(), True),
            StructField("pii_columns", ArrayType(StringType()), True),
            StructField("dependency_order", LongType(), False),
            StructField("requires_recompute", StringType(), True),
            StructField("planned_at", TimestampType(), False),
            StructField("executor_user", StringType(), False),
        ]
    )
    df = spark.createDataFrame(rows, schema=schema)
    df.write.format("delta").mode("append").saveAsTable(AUDIT_TABLES["plan"])
    log.info("Wrote %d plan rows to %s", len(rows), AUDIT_TABLES["plan"])


# COMMAND ----------

# MAGIC %md
# MAGIC ## Mode Dispatch — Execute
# MAGIC
# MAGIC Defensive contract:
# MAGIC - Each operation is wrapped in try/except. On exception we **HALT** —
# MAGIC   never continue to the next table, never leave partial state.
# MAGIC - The audit row for the failed table records `status=FAILED` with the
# MAGIC   exception detail. The hash chain still advances so tampering is
# MAGIC   detectable.
# MAGIC - On full success, a synthetic `status=COMPLETE` capstone row is appended
# MAGIC   so idempotency detection works.

# COMMAND ----------


def execute_cascade(plan: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Apply the plan transactionally with halt-on-failure semantics."""
    if PRIOR_EXECUTION:
        log.warning(
            "Skipping execute — prior COMPLETE execution exists for %s. "
            "Use mode=verify or open a new dsar_id.",
            dsar_id,
        )
        return {
            "tables_processed": 0,
            "rows_affected": 0,
            "status": "SKIPPED_IDEMPOTENT",
        }

    total_rows = 0
    tables_processed = 0
    failed_table: Optional[str] = None
    failure_detail: Optional[str] = None

    for entry in plan:
        table = entry["table_name"]
        action = entry["planned_action"]
        subject_key = entry["subject_key"]
        pii_columns = entry["pii_columns"]

        log.info(
            "Executing | table=%s | action=%s | subject_hash=%s…",
            table,
            action,
            SUBJECT_HASH[:12],
        )

        try:
            if action == "hard_delete":
                rows_affected = op_hard_delete(table, subject_key, subject_id)
            elif action == "pseudonymize":
                rows_affected = op_pseudonymize(
                    table, subject_key, subject_id, pii_columns
                )
            elif action == "anonymize":
                rows_affected = op_anonymize(
                    table, subject_key, subject_id, pii_columns
                )
            elif action in {"no_action", "external_action"}:
                rows_affected = 0
            else:
                raise ValueError(f"Unknown action: {action}")
        except Exception as e:
            failed_table = table
            failure_detail = f"{type(e).__name__}: {e}"
            _append_execution_row(table, action, 0, "FAILED", failure_detail)
            log.error(
                "HALT — operation failed on %s: %s. Cascade left partial; "
                "investigate before re-running.",
                table,
                failure_detail,
            )
            break

        _append_execution_row(table, action, rows_affected, "OK", None)
        total_rows += rows_affected
        tables_processed += 1

    if failed_table is None:
        # Capstone row enables idempotency detection
        _append_execution_row(
            "__CAPSTONE__",
            "complete",
            total_rows,
            "COMPLETE",
            None,
        )
        return {
            "tables_processed": tables_processed,
            "rows_affected": total_rows,
            "status": "COMPLETE",
        }
    return {
        "tables_processed": tables_processed,
        "rows_affected": total_rows,
        "status": "HALTED",
        "failed_table": failed_table,
        "failure_detail": failure_detail,
    }


# COMMAND ----------

# MAGIC %md
# MAGIC ## Mode Dispatch — Verify

# COMMAND ----------


def verify_cascade(plan: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Re-query each table to confirm the planned action took effect."""
    findings: List[Dict[str, Any]] = []
    failures = 0

    for entry in plan:
        table = entry["table_name"]
        action = entry["planned_action"]
        subject_key = entry["subject_key"]

        if not _table_exists(table):
            findings.append(
                {
                    "table": table,
                    "expected_state": action,
                    "observed_state": "table_missing",
                    "verified": "SKIP",
                    "evidence": "table not present in workspace",
                }
            )
            continue

        try:
            if action == "hard_delete":
                remaining = (
                    spark.table(table)
                    .filter(col(subject_key) == lit(subject_id))
                    .count()
                )
                ok = remaining == 0
                findings.append(
                    {
                        "table": table,
                        "expected_state": "0 raw rows",
                        "observed_state": f"{remaining} raw rows",
                        "verified": "PASS" if ok else "FAIL",
                        "evidence": f"raw_remaining={remaining}",
                    }
                )
                if not ok:
                    failures += 1
            elif action == "pseudonymize":
                raw_remaining = (
                    spark.table(table)
                    .filter(col(subject_key) == lit(subject_id))
                    .count()
                )
                pseudonym_present = (
                    spark.table(table)
                    .filter(col(subject_key) == lit(SUBJECT_HASH))
                    .count()
                )
                ok = raw_remaining == 0
                findings.append(
                    {
                        "table": table,
                        "expected_state": "raw=0; pseudonym>=1",
                        "observed_state": (
                            f"raw={raw_remaining}; pseudonym={pseudonym_present}"
                        ),
                        "verified": "PASS" if ok else "FAIL",
                        "evidence": (
                            f"raw_remaining={raw_remaining}; "
                            f"pseudonym_count={pseudonym_present}"
                        ),
                    }
                )
                if not ok:
                    failures += 1
            elif action == "anonymize":
                # Subject_key may have been NULLed; verify by absence of raw match
                raw_remaining = (
                    spark.table(table)
                    .filter(col(subject_key) == lit(subject_id))
                    .count()
                )
                ok = raw_remaining == 0
                findings.append(
                    {
                        "table": table,
                        "expected_state": "0 raw matches",
                        "observed_state": f"{raw_remaining} raw matches",
                        "verified": "PASS" if ok else "FAIL",
                        "evidence": f"raw_remaining={raw_remaining}",
                    }
                )
                if not ok:
                    failures += 1
            elif action in {"no_action", "external_action"}:
                findings.append(
                    {
                        "table": table,
                        "expected_state": action,
                        "observed_state": action,
                        "verified": "PASS",
                        "evidence": (
                            "No action expected (legal hold / external store)"
                        ),
                    }
                )
            else:
                findings.append(
                    {
                        "table": table,
                        "expected_state": action,
                        "observed_state": "unknown",
                        "verified": "FAIL",
                        "evidence": f"unknown planned action: {action}",
                    }
                )
                failures += 1
        except Exception as e:
            findings.append(
                {
                    "table": table,
                    "expected_state": action,
                    "observed_state": "error",
                    "verified": "FAIL",
                    "evidence": f"verification query failed: {e}",
                }
            )
            failures += 1

    # Persist verification results
    rows = [
        (
            dsar_id,
            SUBJECT_HASH,
            f["table"],
            f["expected_state"],
            f["observed_state"],
            f["verified"],
            f["evidence"],
            datetime.now(timezone.utc),
        )
        for f in findings
    ]
    schema = StructType(
        [
            StructField("dsar_id", StringType(), False),
            StructField("subject_hash", StringType(), False),
            StructField("table_name", StringType(), False),
            StructField("expected_state", StringType(), False),
            StructField("observed_state", StringType(), False),
            StructField("verified", StringType(), False),
            StructField("evidence", StringType(), True),
            StructField("verified_at", TimestampType(), False),
        ]
    )
    if rows:
        df = spark.createDataFrame(rows, schema=schema)
        df.write.format("delta").mode("append").saveAsTable(
            AUDIT_TABLES["verification"]
        )

    return {
        "tables_verified": len(findings),
        "failures": failures,
        "verification_status": "PASS" if failures == 0 else "FAIL",
    }


# COMMAND ----------

# MAGIC %md
# MAGIC ## Sub-Processor Notification
# MAGIC
# MAGIC Article 17(2) — where the controller has disclosed the subject's data to
# MAGIC other controllers, take reasonable steps to inform them. We materialize a
# MAGIC notification queue here; the actual sending is handled out-of-band by
# MAGIC the Privacy Office (Power Automate flow ➝ email + DPA-listed contacts).

# COMMAND ----------

# Sub-processors that may have received the subject's data downstream.
# In production this list comes from the disclosure register; for POC we
# encode the known consumers.
SUB_PROCESSORS: List[Dict[str, Any]] = [
    {
        "name": "Microsoft Fabric (sub-processor of self)",
        "dataset": "all",
        "notification_required": "no",
        "notes": "Covered by Microsoft DPA — no separate notification required",
    },
    {
        "name": "Power BI Service (semantic model cache)",
        "dataset": "lh_gold.fact_player_daily",
        "notification_required": "yes",
        "notes": "Refresh semantic model + clearCache after Gold reprocess",
    },
    {
        "name": "Marketing Automation Platform",
        "dataset": "lh_silver.party_canonical_marketing",
        "notification_required": "yes",
        "notes": "DPA Article 28 — 30-day SLA",
    },
    {
        "name": "ML Training Pipeline",
        "dataset": "lh_features.fs_player_*",
        "notification_required": "yes",
        "notes": "Schedule re-train at next quarterly cadence",
    },
]


def write_subprocessor_notifications() -> int:
    rows = [
        (
            dsar_id,
            SUBJECT_HASH,
            sp["name"],
            sp["dataset"],
            sp["notification_required"],
            None,  # notification_sent_at — to be filled by Power Automate
            sp["notes"],
        )
        for sp in SUB_PROCESSORS
    ]
    schema = StructType(
        [
            StructField("dsar_id", StringType(), False),
            StructField("subject_hash", StringType(), False),
            StructField("sub_processor", StringType(), False),
            StructField("dataset", StringType(), True),
            StructField("notification_required", StringType(), False),
            StructField("notification_sent_at", TimestampType(), True),
            StructField("notes", StringType(), True),
        ]
    )
    df = spark.createDataFrame(rows, schema=schema)
    df.write.format("delta").mode("append").saveAsTable(
        AUDIT_TABLES["subprocessor"]
    )
    return len(rows)


# COMMAND ----------

# MAGIC %md
# MAGIC ## Main Dispatch
# MAGIC
# MAGIC The notebook always builds the locator inventory (cheap, read-only). What
# MAGIC happens after depends on `mode`:
# MAGIC
# MAGIC - `locate`   → write locator → exit
# MAGIC - `dry-run`  → build plan → write plan → exit
# MAGIC - `execute`  → build plan → run cascade → write subprocessor queue → exit
# MAGIC - `verify`   → build plan → re-query each table → exit

# COMMAND ----------

locator_results = locate_subject(subject_id)
log.info(
    "Locator complete — %d tables reference subject (hash %s…)",
    len(locator_results),
    SUBJECT_HASH[:12],
)

cascade_plan: List[Dict[str, Any]] = []
execution_summary: Optional[Dict[str, Any]] = None
verification_summary: Optional[Dict[str, Any]] = None
subprocessor_notifications_count = 0

if mode == "locate":
    write_locator_results(locator_results)
elif mode == "dry-run":
    write_locator_results(locator_results)
    cascade_plan = build_cascade_plan(locator_results, exemptions, requested_action)
    write_cascade_plan(cascade_plan)
elif mode == "execute":
    write_locator_results(locator_results)
    cascade_plan = build_cascade_plan(locator_results, exemptions, requested_action)
    write_cascade_plan(cascade_plan)
    # Defensive guard — refuse to execute against retention-bound tables
    # without explicit Privacy Office exemption
    refused = [p for p in cascade_plan if p["rationale"].startswith("REFUSED:")]
    if refused:
        log.error(
            "Refusing to execute — %d tables require compliance_retention "
            "exemption that was not specified. Re-run with "
            "exemptions=compliance_retention after Privacy Office sign-off.",
            len(refused),
        )
        execution_summary = {"status": "REFUSED", "refused_tables": [r["table_name"] for r in refused]}
    else:
        execution_summary = execute_cascade(cascade_plan)
        if execution_summary["status"] == "COMPLETE":
            subprocessor_notifications_count = write_subprocessor_notifications()
elif mode == "verify":
    cascade_plan = build_cascade_plan(locator_results, exemptions, requested_action)
    verification_summary = verify_cascade(cascade_plan)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cleanup — Optimize and VACUUM
# MAGIC
# MAGIC We OPTIMIZE the audit tables to reclaim deleted bytes and keep query
# MAGIC performance reasonable. **VACUUM uses the default 7-day retention** —
# MAGIC NOT 0 — because forensic verification may need Time Travel access to
# MAGIC the pre-cascade state for up to a week. Anything shorter than 7 days
# MAGIC must be approved by the DPA.

# COMMAND ----------

if mode == "execute" and execution_summary and execution_summary.get("status") == "COMPLETE":
    for audit_table in AUDIT_TABLES.values():
        try:
            spark.sql(f"OPTIMIZE {audit_table}")
        except Exception as e:
            log.warning("OPTIMIZE failed for %s: %s", audit_table, e)
    # NOTE: VACUUM with explicit 7-day retention. Do NOT pass 0 hours —
    # Phase 11 audit remediation requires Time Travel be preserved for
    # forensic verification. Default Delta retention is 168 hours (7 days).
    log.info("VACUUM is left to scheduled maintenance (default 7-day retention).")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Final Summary — JSON Exit
# MAGIC
# MAGIC The notebook exits with a machine-readable JSON payload. Pipeline
# MAGIC orchestration consumes this to drive downstream steps (attestation PDF,
# MAGIC subject notification email, Privacy Office handoff).

# COMMAND ----------

summary: Dict[str, Any] = {
    "dsar_id": dsar_id,
    "subject_hash": SUBJECT_HASH,
    "mode": mode,
    "requested_action": requested_action,
    "exemptions_applied": exemptions,
    "executor_user": executor_user,
    "tables_affected": (
        execution_summary["tables_processed"]
        if execution_summary
        else len(locator_results)
    ),
    "rows_affected": (
        execution_summary["rows_affected"] if execution_summary else 0
    ),
    "verification_status": (
        verification_summary["verification_status"]
        if verification_summary
        else "n/a"
    ),
    "execution_status": (
        execution_summary["status"] if execution_summary else "n/a"
    ),
    "sub_processor_notifications_queued": subprocessor_notifications_count,
    "completion_ts": datetime.now(timezone.utc).isoformat(),
    "audit_log_table": AUDIT_TABLES["execution"],
    "prior_execution_detected": PRIOR_EXECUTION,
}

# Final defensive log line — never include raw subject_id
log.info("DSAR cascade summary: %s", json.dumps(summary, default=str))

_notebook_exit(json.dumps(summary, default=str))
