# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: MDM Golden Record — Player Master (Match + Merge + Survivorship)
# MAGIC
# MAGIC **Layer:** Gold &nbsp;|&nbsp; **Domain:** Casino &nbsp;|&nbsp; **Phase:** 14 Wave 3 &nbsp;|&nbsp; **Feature:** 3.8
# MAGIC
# MAGIC This notebook operationalizes the Master Data Management (MDM) patterns documented in
# MAGIC [`docs/best-practices/data-management/master-data-management.md`](../../docs/best-practices/data-management/master-data-management.md)
# MAGIC against the casino **Player Master** domain. It demonstrates the end-to-end MDM hub
# MAGIC pipeline for resolving the same physical person who appears across four operational
# MAGIC source systems with different keys, different schemas, typos, missing fields, nicknames,
# MAGIC and varying recency.
# MAGIC
# MAGIC ## What this notebook does
# MAGIC
# MAGIC 1. Generates four synthetic **Silver canonical** source tables (CRM, Loyalty, Compliance, Helpdesk)
# MAGIC    with realistic overlap, typos, nicknames, and missing fields. PII (SSN) is **always hashed** —
# MAGIC    even in synthetic data.
# MAGIC 2. **Standardizes** the union of all sources (email lower/trim, phone digits-only, name title-case).
# MAGIC 3. Runs **Tier 1 deterministic matching** (exact match on `ssn_hash`, `email_norm`, or `phone_norm`).
# MAGIC 4. Runs **Tier 2 probabilistic matching** with blocking (last-name prefix + DOB year) and a
# MAGIC    weighted Jaro-Winkler / Levenshtein similarity score; auto-merge ≥ 0.92, review queue 0.78–0.92.
# MAGIC 5. Forms **clusters** using a Union-Find / connected-components algorithm on the matched pairs.
# MAGIC 6. Writes **`lh_gold.party_xref`** — every source record → its cluster + match tier + score.
# MAGIC 7. Applies per-attribute **survivorship rules** (most_complete / most_recent / source_priority /
# MAGIC    longest_string), capturing **which source** and **which rule** produced each value.
# MAGIC 8. Mints a **stable `master_id`** seeded from the existing golden table to avoid collisions on re-runs.
# MAGIC 9. Writes **`lh_gold.party_golden`** with **SCD2** columns (`effective_from`, `effective_to`,
# MAGIC    `is_current`) using a Delta `MERGE` that closes the prior current row when attributes change.
# MAGIC 10. Computes **MDM quality metrics** (match coverage, auto-merge rate, review queue size,
# MAGIC     completeness) and writes them to `lh_gold.mdm_quality_metrics`.
# MAGIC 11. Persists the **review queue** (`lh_gold.party_review_queue`) for steward decisions.
# MAGIC
# MAGIC > **Defensive design.** Synthetic data is generated inline so the notebook is fully self-contained.
# MAGIC > `rapidfuzz` is used when available for fast Jaro-Winkler; we fall back to a pure-Python
# MAGIC > Levenshtein-derived similarity if the library is missing.
# MAGIC
# MAGIC ## Related documentation
# MAGIC
# MAGIC - **Anchor doc:** `docs/best-practices/data-management/master-data-management.md`
# MAGIC - **SCD2:** `docs/best-practices/data-management/scd-patterns.md`
# MAGIC - **Late arrivals:** `docs/best-practices/data-management/late-arriving-data.md`
# MAGIC - **Data products:** `docs/best-practices/data-management/data-product-framework.md`

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup — imports, parameters, runtime shim

# COMMAND ----------

import hashlib
import os
import random
import string
from datetime import datetime, timedelta

from delta.tables import DeltaTable
from pyspark.sql import DataFrame, Row
from pyspark.sql.functions import (
    coalesce,
    col,
    concat_ws,
    count,
    countDistinct,
    current_timestamp,
    initcap,
    length,
    lit,
    lower,
    max as spark_max,
    min as spark_min,
    regexp_replace,
    row_number,
    sum as spark_sum,
    trim,
    when,
    year,
)
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)
from pyspark.sql.window import Window


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default."""
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
    """Exit notebook with status (Fabric/Synapse pipelines consume this)."""
    try:
        import notebookutils
        notebookutils.notebook.exit(status)
    except Exception:
        try:
            import mssparkutils
            mssparkutils.notebook.exit(status)
        except Exception:
            raise SystemExit(status)


# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))
seed = int(_get_arg("seed", "42") or "42")

# Source canonical tables (Silver)
SRC_CRM = "lh_silver.party_canonical_crm"
SRC_LOYALTY = "lh_silver.party_canonical_loyalty"
SRC_COMPLIANCE = "lh_silver.party_canonical_compliance"
SRC_HELPDESK = "lh_silver.party_canonical_helpdesk"

# Gold targets
TARGET_GOLDEN = "lh_gold.party_golden"
TARGET_XREF = "lh_gold.party_xref"
TARGET_REVIEW = "lh_gold.party_review_queue"
TARGET_METRICS = "lh_gold.mdm_quality_metrics"

# Match thresholds (see master-data-management.md → Match Strategies)
AUTO_MERGE_THRESHOLD = 0.92
REVIEW_THRESHOLD = 0.78

# Source priority for source_priority survivorship rule (lower index = higher priority)
SOURCE_PRIORITY_PHONE = ["crm", "helpdesk", "loyalty", "compliance"]
SOURCE_PRIORITY_DOB = ["compliance", "crm", "loyalty", "helpdesk"]
SOURCE_PRIORITY_SSN = ["compliance"]  # Compliance only

# PII salt — required env var (matches Phase 11 fix in CLAUDE.md)
PII_SALT = os.environ.get("FABRIC_POC_HASH_SALT", "fabric-poc-demo-salt-DO-NOT-USE-IN-PROD")

print(f"Batch: {batch_id}")
print(f"Seed: {seed}")
print(f"Auto-merge threshold: {AUTO_MERGE_THRESHOLD}")
print(f"Review threshold: {REVIEW_THRESHOLD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optional library: rapidfuzz with pure-Python fallback
# MAGIC
# MAGIC We prefer `rapidfuzz` (Jaro-Winkler in C, ~50× faster than pure Python). If the library is
# MAGIC unavailable we fall back to a normalized Levenshtein ratio so the notebook always runs.

# COMMAND ----------

try:
    from rapidfuzz import fuzz as _rf_fuzz  # type: ignore
    _HAS_RAPIDFUZZ = True
    print("rapidfuzz available — using Jaro-Winkler (WRatio)")
except Exception:
    _rf_fuzz = None
    _HAS_RAPIDFUZZ = False
    print("rapidfuzz NOT available — using pure-Python Levenshtein fallback")


def _levenshtein(a: str, b: str) -> int:
    """Pure-Python Levenshtein distance (used only if rapidfuzz is missing)."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    # Two-row dynamic programming
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            curr[j] = min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[-1]


def string_similarity(a, b) -> float:
    """Return [0.0, 1.0] similarity. Uses rapidfuzz WRatio when available."""
    if a is None or b is None:
        return 0.0
    a_s, b_s = str(a).strip().lower(), str(b).strip().lower()
    if not a_s or not b_s:
        return 0.0
    if a_s == b_s:
        return 1.0
    if _HAS_RAPIDFUZZ:
        return _rf_fuzz.WRatio(a_s, b_s) / 100.0
    # Levenshtein-derived ratio (1 - distance / max_len)
    dist = _levenshtein(a_s, b_s)
    max_len = max(len(a_s), len(b_s))
    return 1.0 - (dist / max_len) if max_len > 0 else 0.0

# COMMAND ----------

# MAGIC %md
# MAGIC ## Generate synthetic source canonical data
# MAGIC
# MAGIC We simulate the four real-world source systems described in the anchor doc's
# MAGIC "Casino Implementation: Player Master" section. Realistic duplicate patterns we inject:
# MAGIC
# MAGIC | Pattern | Example |
# MAGIC |---|---|
# MAGIC | Nicknames | `Robert` ↔ `Bob`, `Elizabeth` ↔ `Liz`, `Jennifer` ↔ `Jenny` |
# MAGIC | Typos | `Smith` ↔ `Smyth`, `Johnson` ↔ `Jonson` |
# MAGIC | Missing fields | Helpdesk has no SSN; Loyalty often missing DOB |
# MAGIC | Format drift | Phone `(555) 123-4567` vs `5551234567`; email casing |
# MAGIC | Address abbreviation | `100 Main Street` vs `100 Main St` |
# MAGIC | Recency | CRM updated yesterday vs Loyalty 2 years ago |
# MAGIC
# MAGIC PII (SSN) is hashed at generation time — we never materialize a clear-text SSN.

# COMMAND ----------

# Ensure target lakehouses/databases exist
spark.sql("CREATE DATABASE IF NOT EXISTS lh_silver")
spark.sql("CREATE DATABASE IF NOT EXISTS lh_gold")

NICKNAMES = {
    "Robert": ["Bob", "Bobby", "Rob"],
    "Elizabeth": ["Liz", "Beth", "Eliza"],
    "Jennifer": ["Jenny", "Jen"],
    "William": ["Bill", "Will", "Willie"],
    "Margaret": ["Maggie", "Meg", "Peggy"],
    "Christopher": ["Chris", "Topher"],
    "Michael": ["Mike", "Mikey"],
    "James": ["Jim", "Jimmy"],
    "Katherine": ["Kate", "Katie", "Kathy"],
    "Richard": ["Rick", "Dick", "Rich"],
}

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
    "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
    "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
]

TYPO_MAP = {
    "Smith": "Smyth", "Johnson": "Jonson", "Williams": "Wiliams",
    "Brown": "Browne", "Jones": "Joness", "Davis": "Daviss",
    "Wilson": "Willson", "Anderson": "Andersen", "Thomas": "Tomas",
}

CITIES = ["Las Vegas", "Reno", "Atlantic City", "Biloxi", "Detroit", "New Orleans"]
STATE = "NV"


def _hash_ssn(person_id: int) -> str:
    """Deterministic hash of a synthetic SSN — never materialize clear text."""
    # Use 900-series synthetic SSN per Phase 11 PII fix (CLAUDE.md)
    synthetic_ssn = f"900-{(person_id % 100):02d}-{(person_id * 7 % 10000):04d}"
    return hashlib.sha256(f"{PII_SALT}:{synthetic_ssn}".encode()).hexdigest()[:32]


def _build_persons(n: int = 1200, rng: random.Random = None) -> list:
    """Build a population of canonical persons. Each person may appear in 1-4 sources."""
    rng = rng or random.Random(seed)
    persons = []
    first_names_canonical = list(NICKNAMES.keys()) + [
        "John", "Mary", "David", "Sarah", "Joseph", "Patricia", "Charles", "Linda",
    ]
    for pid in range(1, n + 1):
        first = rng.choice(first_names_canonical)
        last = rng.choice(LAST_NAMES)
        dob = datetime(rng.randint(1940, 2003), rng.randint(1, 12), rng.randint(1, 28))
        phone_digits = "".join(rng.choices(string.digits, k=10))
        zip_code = f"{rng.randint(10000, 99999)}"
        street_num = rng.randint(100, 9999)
        street = rng.choice(["Main St", "Oak Ave", "Elm Dr", "First Blvd", "Park Ln"])
        persons.append({
            "person_id": pid,
            "first_canonical": first,
            "last_canonical": last,
            "dob": dob,
            "email_local": f"{first.lower()}.{last.lower()}{pid}",
            "email_domain": rng.choice(["example.com", "mail.test", "demo.org"]),
            "phone_digits": phone_digits,
            "ssn_hash": _hash_ssn(pid),
            "address_num": street_num,
            "address_street": street,
            "address_zip": zip_code,
            "address_city": rng.choice(CITIES),
        })
    return persons


def _maybe_typo(name: str, rng: random.Random, prob: float = 0.15) -> str:
    """Sometimes introduce a realistic typo on a last name."""
    if rng.random() < prob and name in TYPO_MAP:
        return TYPO_MAP[name]
    return name


def _maybe_nickname(first: str, rng: random.Random, prob: float = 0.4) -> str:
    """Sometimes use a nickname instead of the canonical first name."""
    if first in NICKNAMES and rng.random() < prob:
        return rng.choice(NICKNAMES[first])
    return first


def _format_phone(digits: str, fmt: str) -> str:
    if fmt == "paren":
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    if fmt == "dash":
        return f"{digits[:3]}-{digits[3:6]}-{digits[6:]}"
    return digits  # raw digits


def _format_address(num: int, street: str, abbreviate: bool) -> str:
    if abbreviate:
        return f"{num} {street}"
    return f"{num} {street.replace(' St', ' Street').replace(' Ave', ' Avenue').replace(' Dr', ' Drive').replace(' Blvd', ' Boulevard').replace(' Ln', ' Lane')}"


def _emit_record(person: dict, source: str, rng: random.Random, include_ssn: bool, include_dob: bool, recency_days_back: int) -> dict:
    """Build a single source record from a canonical person, with realistic noise."""
    first = _maybe_nickname(person["first_canonical"], rng)
    last = _maybe_typo(person["last_canonical"], rng)
    phone_fmt = rng.choice(["paren", "dash", "raw"])
    abbreviate = rng.random() < 0.5
    last_updated = datetime.now() - timedelta(days=rng.randint(0, recency_days_back), hours=rng.randint(0, 23))
    # Field dropouts vary by source (Helpdesk loses fields more often)
    drop_email = source == "helpdesk" and rng.random() < 0.25
    drop_phone = rng.random() < (0.25 if source == "loyalty" else 0.05)
    return {
        "record_id": None,  # Filled later
        "source_system": source,
        "source_record_id": f"{source.upper()}-{person['person_id']}-{rng.randint(1000, 9999)}",
        "first_name": first,
        "last_name": last,
        "email": None if drop_email else f"{person['email_local']}@{person['email_domain']}".upper() if rng.random() < 0.3 else f"{person['email_local']}@{person['email_domain']}",
        "phone": None if drop_phone else _format_phone(person["phone_digits"], phone_fmt),
        "dob": person["dob"] if include_dob else None,
        "ssn_hash": person["ssn_hash"] if include_ssn else None,
        "address_line1": _format_address(person["address_num"], person["address_street"], abbreviate),
        "address_zip": person["address_zip"],
        "last_updated": last_updated,
    }


def _build_source_records(persons: list, source: str, target_count: int, overlap_pct: float,
                          include_ssn: bool, include_dob_pct: float, recency_days_back: int,
                          rng: random.Random) -> list:
    """Pick a subset of persons and emit source-specific records."""
    overlap_pool = persons[: int(len(persons) * overlap_pct)]
    other_pool = persons[int(len(persons) * overlap_pct):]
    records = []
    # Emit records from overlap pool (these collide across sources)
    for person in overlap_pool:
        if len(records) >= target_count:
            break
        if rng.random() < 0.85:  # Most overlap persons appear in this source
            records.append(_emit_record(person, source, rng, include_ssn,
                                        include_dob=rng.random() < include_dob_pct,
                                        recency_days_back=recency_days_back))
    # Top up from "exclusive" pool
    remaining = target_count - len(records)
    for person in rng.sample(other_pool, min(remaining, len(other_pool))):
        records.append(_emit_record(person, source, rng, include_ssn,
                                    include_dob=rng.random() < include_dob_pct,
                                    recency_days_back=recency_days_back))
    # Inject occasional intra-source duplicate (same person, two records in same source)
    duplicate_count = max(1, int(target_count * 0.03))
    for person in rng.sample(records, min(duplicate_count, len(records))):
        records.append(dict(person))  # shallow copy, will get new record_id
    return records


print("Generating synthetic person population...")
rng = random.Random(seed)
persons = _build_persons(n=1200, rng=rng)
print(f"  Canonical persons: {len(persons):,}")

print("Generating source records...")
crm_records = _build_source_records(persons, "crm", target_count=1000, overlap_pct=1.0,
                                    include_ssn=False, include_dob_pct=0.95,
                                    recency_days_back=30, rng=rng)
loyalty_records = _build_source_records(persons, "loyalty", target_count=800, overlap_pct=0.70,
                                        include_ssn=False, include_dob_pct=0.50,
                                        recency_days_back=730, rng=rng)
compliance_records = _build_source_records(persons, "compliance", target_count=200, overlap_pct=0.50,
                                           include_ssn=True, include_dob_pct=1.0,
                                           recency_days_back=180, rng=rng)
helpdesk_records = _build_source_records(persons, "helpdesk", target_count=500, overlap_pct=0.60,
                                         include_ssn=False, include_dob_pct=0.30,
                                         recency_days_back=365, rng=rng)

print(f"  CRM:        {len(crm_records):,}")
print(f"  Loyalty:    {len(loyalty_records):,}")
print(f"  Compliance: {len(compliance_records):,}")
print(f"  Helpdesk:   {len(helpdesk_records):,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Materialize source canonical Silver tables
# MAGIC
# MAGIC We persist each source as a Silver canonical Delta table so the MDM hub can be re-run
# MAGIC repeatedly without regenerating. Schema is consistent across all sources to enable a clean
# MAGIC `UNION ALL` in the standardization stage.

# COMMAND ----------

CANONICAL_SCHEMA = StructType([
    StructField("record_id", LongType(), False),
    StructField("source_system", StringType(), False),
    StructField("source_record_id", StringType(), False),
    StructField("first_name", StringType(), True),
    StructField("last_name", StringType(), True),
    StructField("email", StringType(), True),
    StructField("phone", StringType(), True),
    StructField("dob", TimestampType(), True),
    StructField("ssn_hash", StringType(), True),
    StructField("address_line1", StringType(), True),
    StructField("address_zip", StringType(), True),
    StructField("last_updated", TimestampType(), False),
])


def _records_to_df(records: list, starting_record_id: int) -> DataFrame:
    rows = []
    for i, r in enumerate(records, start=starting_record_id):
        rows.append(Row(
            record_id=int(i),
            source_system=r["source_system"],
            source_record_id=r["source_record_id"],
            first_name=r["first_name"],
            last_name=r["last_name"],
            email=r["email"],
            phone=r["phone"],
            dob=r["dob"],
            ssn_hash=r["ssn_hash"],
            address_line1=r["address_line1"],
            address_zip=r["address_zip"],
            last_updated=r["last_updated"],
        ))
    return spark.createDataFrame(rows, schema=CANONICAL_SCHEMA)


# Assign monotonic record_ids across all sources (no overlap)
df_crm = _records_to_df(crm_records, starting_record_id=1)
df_loyalty = _records_to_df(loyalty_records, starting_record_id=1 + len(crm_records))
df_compliance = _records_to_df(compliance_records, starting_record_id=1 + len(crm_records) + len(loyalty_records))
df_helpdesk = _records_to_df(helpdesk_records, starting_record_id=1 + len(crm_records) + len(loyalty_records) + len(compliance_records))

for tbl, df in [(SRC_CRM, df_crm), (SRC_LOYALTY, df_loyalty),
                (SRC_COMPLIANCE, df_compliance), (SRC_HELPDESK, df_helpdesk)]:
    df.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(tbl)
    print(f"Wrote {tbl}: {spark.table(tbl).count():,} records")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Standardization
# MAGIC
# MAGIC The MDM doc emphasizes that match quality lives or dies by **normalization**. We:
# MAGIC
# MAGIC - lowercase + trim email
# MAGIC - strip non-digits from phone (the most common drift across systems)
# MAGIC - title-case + trim names (preserves case-insensitive comparison without losing display form)
# MAGIC - lowercase + trim address (used only for similarity, the original is preserved)
# MAGIC
# MAGIC The normalized columns are appended; the originals are kept for survivorship downstream.

# COMMAND ----------

df_union = (
    df_crm.unionByName(df_loyalty)
          .unionByName(df_compliance)
          .unionByName(df_helpdesk)
)

df_std = (df_union
    .withColumn("email_norm", lower(trim(col("email"))))
    .withColumn("phone_norm", regexp_replace(coalesce(col("phone"), lit("")), "[^0-9]", ""))
    .withColumn("phone_norm", when(col("phone_norm") == "", lit(None)).otherwise(col("phone_norm")))
    .withColumn("first_norm", initcap(trim(col("first_name"))))
    .withColumn("last_norm", initcap(trim(col("last_name"))))
    .withColumn("address_norm", lower(trim(col("address_line1"))))
)

df_std.cache()
total_records = df_std.count()
print(f"Standardized records: {total_records:,}")
df_std.groupBy("source_system").count().orderBy("source_system").show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Tier 1 — Deterministic match
# MAGIC
# MAGIC Per the doc's "Deterministic First" pattern: we self-join the standardized union on **any** of
# MAGIC `ssn_hash`, `email_norm`, or `phone_norm` and keep `a.record_id < b.record_id` to avoid
# MAGIC double-counting. Match score is fixed at `1.0` for deterministic pairs.

# COMMAND ----------

a = df_std.alias("a")
b = df_std.alias("b")

deterministic_pairs = (
    a.join(
        b,
        (col("a.record_id") < col("b.record_id")) &
        (
            (col("a.ssn_hash").isNotNull() & (col("a.ssn_hash") == col("b.ssn_hash"))) |
            (col("a.email_norm").isNotNull() & (col("a.email_norm") == col("b.email_norm"))) |
            (col("a.phone_norm").isNotNull() & (col("a.phone_norm") == col("b.phone_norm")))
        ),
        "inner",
    )
    .select(
        col("a.record_id").alias("rid_a"),
        col("b.record_id").alias("rid_b"),
        lit(1.0).alias("match_score"),
        lit("deterministic").alias("match_tier"),
    )
).distinct()

deterministic_pairs.cache()
det_count = deterministic_pairs.count()
print(f"Deterministic pairs: {det_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Tier 2 — Probabilistic match (blocked + weighted similarity)
# MAGIC
# MAGIC Naive pairwise comparison is O(n²). Per the doc's "Blocking — The Key to Scale" section, we
# MAGIC block on **first 3 chars of last name + DOB year**. Within a block we compute a weighted
# MAGIC similarity score:
# MAGIC
# MAGIC ```
# MAGIC score = 0.4 * sim(first_name) + 0.4 * sim(last_name) + 0.2 * sim(address_line1)
# MAGIC ```
# MAGIC
# MAGIC Two thresholds:
# MAGIC - **≥ 0.92** → auto-merge
# MAGIC - **0.78–0.92** → review queue (steward decides)
# MAGIC - **< 0.78** → ignored
# MAGIC
# MAGIC We only consider pairs that did **not** already match deterministically.

# COMMAND ----------

# Build candidate pairs from blocking
blocked = df_std.filter(col("dob").isNotNull() & col("last_norm").isNotNull())
ba = blocked.alias("ba")
bb = blocked.alias("bb")

candidate_pairs = (
    ba.join(
        bb,
        (col("ba.record_id") < col("bb.record_id")) &
        (col("ba.last_norm").substr(1, 3) == col("bb.last_norm").substr(1, 3)) &
        (year(col("ba.dob")) == year(col("bb.dob"))),
        "inner",
    )
    .select(
        col("ba.record_id").alias("rid_a"),
        col("bb.record_id").alias("rid_b"),
        col("ba.first_norm").alias("a_first"),
        col("bb.first_norm").alias("b_first"),
        col("ba.last_norm").alias("a_last"),
        col("bb.last_norm").alias("b_last"),
        col("ba.address_norm").alias("a_addr"),
        col("bb.address_norm").alias("b_addr"),
    )
)

# Subtract deterministic pairs to avoid double-scoring
det_pair_keys = deterministic_pairs.select("rid_a", "rid_b")
candidate_pairs = candidate_pairs.join(det_pair_keys, ["rid_a", "rid_b"], "left_anti")

candidate_count = candidate_pairs.count()
print(f"Probabilistic candidate pairs (after blocking, deterministic-deduped): {candidate_count:,}")


# Score with a pandas_udf for vectorized fuzzy matching
from pyspark.sql.functions import pandas_udf  # noqa: E402
import pandas as pd  # noqa: E402


@pandas_udf(DoubleType())
def weighted_score(a_first: pd.Series, b_first: pd.Series,
                   a_last: pd.Series, b_last: pd.Series,
                   a_addr: pd.Series, b_addr: pd.Series) -> pd.Series:
    """Vectorized 0.4/0.4/0.2 weighted Jaro-Winkler / Levenshtein similarity."""
    out = []
    for af, bf, al, bl, aa, ba_ in zip(a_first, b_first, a_last, b_last, a_addr, b_addr):
        s = (
            0.4 * string_similarity(af, bf) +
            0.4 * string_similarity(al, bl) +
            0.2 * string_similarity(aa, ba_)
        )
        out.append(float(s))
    return pd.Series(out)


df_scored = candidate_pairs.withColumn(
    "match_score",
    weighted_score(
        col("a_first"), col("b_first"),
        col("a_last"), col("b_last"),
        col("a_addr"), col("b_addr"),
    ),
).select("rid_a", "rid_b", "match_score")

df_scored.cache()

prob_auto = df_scored.filter(col("match_score") >= AUTO_MERGE_THRESHOLD).withColumn("match_tier", lit("probabilistic_auto"))
prob_review = df_scored.filter(
    (col("match_score") >= REVIEW_THRESHOLD) & (col("match_score") < AUTO_MERGE_THRESHOLD)
).withColumn("match_tier", lit("probabilistic_review"))

prob_auto_count = prob_auto.count()
prob_review_count = prob_review.count()
print(f"Probabilistic auto-merge pairs (>= {AUTO_MERGE_THRESHOLD}): {prob_auto_count:,}")
print(f"Review queue pairs ({REVIEW_THRESHOLD} <= score < {AUTO_MERGE_THRESHOLD}): {prob_review_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cluster formation — Union-Find connected components
# MAGIC
# MAGIC We collect all auto-merge pairs (deterministic + high-confidence probabilistic) to the driver
# MAGIC and run a Union-Find. For the POC scale (~2.5K records) this is trivial; for production scale,
# MAGIC swap in GraphFrames `connectedComponents` or splink's clustering.
# MAGIC
# MAGIC Every record_id ends up with a `cluster_id`. Singletons (no matches) get their own cluster.

# COMMAND ----------

auto_pairs = (
    deterministic_pairs.select("rid_a", "rid_b")
    .unionByName(prob_auto.select("rid_a", "rid_b"))
    .distinct()
)

auto_pair_rows = auto_pairs.collect()
all_record_ids = [r["record_id"] for r in df_std.select("record_id").collect()]


class _UnionFind:
    """Classic Union-Find with path compression + union by rank."""

    def __init__(self, items):
        self.parent = {x: x for x in items}
        self.rank = {x: 0 for x in items}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]  # path compression
            x = self.parent[x]
        return x

    def union(self, x, y):
        rx, ry = self.find(x), self.find(y)
        if rx == ry:
            return
        if self.rank[rx] < self.rank[ry]:
            rx, ry = ry, rx
        self.parent[ry] = rx
        if self.rank[rx] == self.rank[ry]:
            self.rank[rx] += 1


uf = _UnionFind(all_record_ids)
for row in auto_pair_rows:
    uf.union(row["rid_a"], row["rid_b"])

cluster_assignments = [(rid, uf.find(rid)) for rid in all_record_ids]
df_clusters = spark.createDataFrame(cluster_assignments, schema=["record_id", "cluster_id"])

cluster_count = df_clusters.select("cluster_id").distinct().count()
multi_record_clusters = (
    df_clusters.groupBy("cluster_id").count().filter(col("count") > 1).count()
)
print(f"Total clusters: {cluster_count:,}")
print(f"Clusters with > 1 record (real merges): {multi_record_clusters:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write cross-reference (`lh_gold.party_xref`)
# MAGIC
# MAGIC Every source record → its cluster + the match tier that placed it there + match score.
# MAGIC This is the bidirectional bridge between source systems and the golden record.

# COMMAND ----------

# Build a per-record best match_tier + score (max score wins; deterministic > probabilistic)
TIER_RANK = {"deterministic": 3, "probabilistic_auto": 2, "probabilistic_review": 1, "singleton": 0}

# All pairs with tier
all_scored_pairs = (
    deterministic_pairs.select("rid_a", "rid_b", "match_score", "match_tier")
    .unionByName(prob_auto.select("rid_a", "rid_b", "match_score", "match_tier"))
    .unionByName(prob_review.select("rid_a", "rid_b", "match_score", "match_tier"))
)

# Flatten into per-record max
unilateral = (
    all_scored_pairs.selectExpr("rid_a as record_id", "match_score", "match_tier")
    .unionByName(all_scored_pairs.selectExpr("rid_b as record_id", "match_score", "match_tier"))
)

# Pick best tier+score per record
w = Window.partitionBy("record_id").orderBy(col("match_score").desc())
best_per_record = (
    unilateral.withColumn("rn", row_number().over(w))
    .filter(col("rn") == 1)
    .drop("rn")
)

df_xref = (
    df_std.select("record_id", "source_system", "source_record_id")
    .join(df_clusters, "record_id", "left")
    .join(best_per_record, "record_id", "left")
    .withColumn("match_tier", coalesce(col("match_tier"), lit("singleton")))
    .withColumn("match_score", coalesce(col("match_score"), lit(1.0)))
    .withColumn("_xref_timestamp", current_timestamp())
    .withColumn("_batch_id", lit(batch_id))
)

df_xref.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(TARGET_XREF)
print(f"Wrote {TARGET_XREF}: {spark.table(TARGET_XREF).count():,} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Survivorship — per-attribute rules with provenance
# MAGIC
# MAGIC Per the anchor doc's "Encoding Survivorship as Code" section, we apply different rules per
# MAGIC attribute and record both the `source_record_id` that won and the `rule` that fired:
# MAGIC
# MAGIC | Attribute | Rule | Why |
# MAGIC |---|---|---|
# MAGIC | `first_name` | most_complete | First non-null wins (any source likely correct) |
# MAGIC | `last_name` | most_complete | Same — both are casino-quality fields |
# MAGIC | `email` | most_recent | People change email; latest wins |
# MAGIC | `phone` | source_priority | CRM > Helpdesk > Loyalty > Compliance |
# MAGIC | `ssn_hash` | source_priority | Compliance only — others may have wrong/stale |
# MAGIC | `dob` | source_priority | Compliance > CRM > Loyalty > Helpdesk |
# MAGIC | `address_line1` | longest_string | Verbose ("100 Main Street Apt 4B") usually more correct |
# MAGIC
# MAGIC We compute survivorship in pandas-on-driver after grouping by `cluster_id` because the
# MAGIC per-attribute logic is heterogeneous and POC-scale clusters fit easily in memory. For
# MAGIC production scale, port to a Spark `groupBy().applyInPandas()` UDF.

# COMMAND ----------

df_records_with_clusters = df_std.join(df_clusters, "record_id", "left")
pdf_records = df_records_with_clusters.select(
    "record_id", "cluster_id", "source_system", "source_record_id",
    "first_name", "last_name", "email", "phone",
    "dob", "ssn_hash", "address_line1", "address_zip", "last_updated",
).toPandas()

print(f"Records loaded for survivorship: {len(pdf_records):,}")
print(f"Distinct clusters: {pdf_records['cluster_id'].nunique():,}")


def _pick_most_complete(group: "pd.DataFrame", attr: str):
    """Return (value, source_record_id) of first non-null value, else (None, None)."""
    sub = group[group[attr].notnull()]
    if sub.empty:
        return None, None
    row = sub.iloc[0]
    return row[attr], row["source_record_id"]


def _pick_most_recent(group: "pd.DataFrame", attr: str):
    """Most-recent-wins by last_updated. Skips nulls."""
    sub = group[group[attr].notnull()].sort_values("last_updated", ascending=False)
    if sub.empty:
        return None, None
    row = sub.iloc[0]
    return row[attr], row["source_record_id"]


def _pick_by_priority(group: "pd.DataFrame", attr: str, priority: list):
    """Source priority — first source in priority list with a non-null value wins."""
    for src in priority:
        sub = group[(group["source_system"] == src) & (group[attr].notnull())]
        if not sub.empty:
            row = sub.iloc[0]
            return row[attr], row["source_record_id"]
    return None, None


def _pick_longest_string(group: "pd.DataFrame", attr: str):
    """Longest non-null string wins (often the most descriptive value)."""
    sub = group[group[attr].notnull()].copy()
    if sub.empty:
        return None, None
    sub["_len"] = sub[attr].astype(str).str.len()
    row = sub.sort_values("_len", ascending=False).iloc[0]
    return row[attr], row["source_record_id"]


def survivorship_for_cluster(cluster_id: int, group: "pd.DataFrame") -> dict:
    """Apply the rule catalog and return one golden row + provenance."""
    out = {"cluster_id": int(cluster_id), "record_count": int(len(group))}

    out["first_name"], out["first_name_source_record_id"] = _pick_most_complete(group, "first_name")
    out["first_name_rule"] = "most_complete"

    out["last_name"], out["last_name_source_record_id"] = _pick_most_complete(group, "last_name")
    out["last_name_rule"] = "most_complete"

    out["email"], out["email_source_record_id"] = _pick_most_recent(group, "email")
    out["email_rule"] = "most_recent"

    out["phone"], out["phone_source_record_id"] = _pick_by_priority(group, "phone", SOURCE_PRIORITY_PHONE)
    out["phone_rule"] = "source_priority"

    out["ssn_hash"], out["ssn_hash_source_record_id"] = _pick_by_priority(group, "ssn_hash", SOURCE_PRIORITY_SSN)
    out["ssn_hash_rule"] = "source_priority"

    out["dob"], out["dob_source_record_id"] = _pick_by_priority(group, "dob", SOURCE_PRIORITY_DOB)
    out["dob_rule"] = "source_priority"

    out["address_line1"], out["address_line1_source_record_id"] = _pick_longest_string(group, "address_line1")
    out["address_line1_rule"] = "longest_string"

    out["address_zip"], out["address_zip_source_record_id"] = _pick_most_recent(group, "address_zip")
    out["address_zip_rule"] = "most_recent"

    # Confidence proxy = mean across "we resolved a value for this attribute"
    resolved = sum(1 for k in ["first_name", "last_name", "email", "phone", "dob", "address_line1"] if out[k])
    out["confidence_score"] = resolved / 6.0
    return out


golden_rows = []
for cluster_id, group in pdf_records.groupby("cluster_id"):
    golden_rows.append(survivorship_for_cluster(cluster_id, group))

pdf_golden = pd.DataFrame(golden_rows)
print(f"Golden records produced: {len(pdf_golden):,}")
pdf_golden.head()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Mint stable `master_id`
# MAGIC
# MAGIC Per the doc's "Stable Identifier Strategy" — `master_id` MUST survive cluster splits/merges.
# MAGIC We seed from the existing `lh_gold.party_golden` table (if present) so re-runs don't reuse IDs:
# MAGIC
# MAGIC 1. Read existing `(cluster_id → master_id)` mappings from prior current rows
# MAGIC 2. For new clusters, mint a new master_id starting from `MAX(master_id) + 1`
# MAGIC 3. Never reassign an existing `master_id`

# COMMAND ----------

existing_max_master_id = 0
existing_cluster_to_master = {}

if spark.catalog.tableExists(TARGET_GOLDEN):
    existing = (
        spark.table(TARGET_GOLDEN)
        .filter(col("is_current") == True)  # noqa: E712
        .select("cluster_id", "master_id")
        .toPandas()
    )
    if not existing.empty:
        existing_max_master_id = int(existing["master_id"].max())
        existing_cluster_to_master = dict(zip(existing["cluster_id"], existing["master_id"]))
    print(f"Existing golden table found. Max master_id: {existing_max_master_id:,}, "
          f"existing mappings: {len(existing_cluster_to_master):,}")
else:
    print("No existing golden table — minting master_ids from 1.")

next_master_id = existing_max_master_id + 1
master_ids = []
for cid in pdf_golden["cluster_id"]:
    if cid in existing_cluster_to_master:
        master_ids.append(int(existing_cluster_to_master[cid]))
    else:
        master_ids.append(next_master_id)
        next_master_id += 1
pdf_golden["master_id"] = master_ids

print(f"Master IDs minted/reused: total={len(master_ids):,}, "
      f"new={sum(1 for m in master_ids if m > existing_max_master_id):,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Promote golden records to Spark + add SCD2 columns
# MAGIC
# MAGIC We add the temporal columns (`effective_from`, `effective_to`, `is_current`) and stage the
# MAGIC new "current as of now" rows for the SCD2 MERGE.

# COMMAND ----------

# Convert pandas → Spark
golden_schema = StructType([
    StructField("cluster_id", LongType(), False),
    StructField("master_id", LongType(), False),
    StructField("record_count", IntegerType(), False),
    StructField("first_name", StringType(), True),
    StructField("first_name_source_record_id", StringType(), True),
    StructField("first_name_rule", StringType(), True),
    StructField("last_name", StringType(), True),
    StructField("last_name_source_record_id", StringType(), True),
    StructField("last_name_rule", StringType(), True),
    StructField("email", StringType(), True),
    StructField("email_source_record_id", StringType(), True),
    StructField("email_rule", StringType(), True),
    StructField("phone", StringType(), True),
    StructField("phone_source_record_id", StringType(), True),
    StructField("phone_rule", StringType(), True),
    StructField("ssn_hash", StringType(), True),
    StructField("ssn_hash_source_record_id", StringType(), True),
    StructField("ssn_hash_rule", StringType(), True),
    StructField("dob", TimestampType(), True),
    StructField("dob_source_record_id", StringType(), True),
    StructField("dob_rule", StringType(), True),
    StructField("address_line1", StringType(), True),
    StructField("address_line1_source_record_id", StringType(), True),
    StructField("address_line1_rule", StringType(), True),
    StructField("address_zip", StringType(), True),
    StructField("address_zip_source_record_id", StringType(), True),
    StructField("address_zip_rule", StringType(), True),
    StructField("confidence_score", DoubleType(), True),
])

# Reorder columns to match schema
ordered_cols = [f.name for f in golden_schema.fields]
pdf_golden_ordered = pdf_golden[ordered_cols].copy()

# Cast cluster_id and master_id to int (pandas may have produced numpy types)
pdf_golden_ordered["cluster_id"] = pdf_golden_ordered["cluster_id"].astype("int64")
pdf_golden_ordered["master_id"] = pdf_golden_ordered["master_id"].astype("int64")
pdf_golden_ordered["record_count"] = pdf_golden_ordered["record_count"].astype("int32")

df_golden_new = spark.createDataFrame(pdf_golden_ordered, schema=golden_schema)

# Append SCD2 columns
df_golden_new = (df_golden_new
    .withColumn("effective_from", current_timestamp())
    .withColumn("effective_to", lit(datetime(9999, 12, 31)).cast(TimestampType()))
    .withColumn("is_current", lit(True))
    .withColumn("_batch_id", lit(batch_id))
)

print(f"Staged golden rows: {df_golden_new.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## SCD2 MERGE into `lh_gold.party_golden`
# MAGIC
# MAGIC Standard SCD2 pattern:
# MAGIC
# MAGIC 1. If `master_id` is brand-new → INSERT current row.
# MAGIC 2. If `master_id` exists and any tracked attribute changed → close prior current row
# MAGIC    (`effective_to = now`, `is_current = false`) and INSERT new current row.
# MAGIC 3. If `master_id` exists and nothing changed → no-op.
# MAGIC
# MAGIC Delta `MERGE` doesn't natively support the "close + insert" two-step, so we run two phases.

# COMMAND ----------

if not spark.catalog.tableExists(TARGET_GOLDEN):
    # First-ever run — straight write
    df_golden_new.write.format("delta").mode("overwrite") \
        .partitionBy("is_current") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_GOLDEN)
    print(f"Initialized {TARGET_GOLDEN} with {spark.table(TARGET_GOLDEN).count():,} rows")
else:
    delta_gold = DeltaTable.forName(spark, TARGET_GOLDEN)

    # Phase 1: close prior current rows where attributes have changed
    tracked_attrs = ["first_name", "last_name", "email", "phone", "ssn_hash",
                     "dob", "address_line1", "address_zip"]
    change_predicate = " OR ".join(
        f"NOT (target.{a} <=> source.{a})" for a in tracked_attrs
    )

    delta_gold.alias("target").merge(
        df_golden_new.alias("source"),
        "target.master_id = source.master_id AND target.is_current = true"
    ).whenMatchedUpdate(
        condition=change_predicate,
        set={
            "effective_to": "current_timestamp()",
            "is_current": "false",
        },
    ).execute()

    # Phase 2: insert new current rows for (a) new master_ids and (b) master_ids whose
    # most-current row was just closed in Phase 1.
    existing_current = (
        spark.table(TARGET_GOLDEN)
        .filter(col("is_current") == True)  # noqa: E712
        .select("master_id")
    )
    df_to_insert = df_golden_new.join(existing_current, "master_id", "left_anti")
    if df_to_insert.count() > 0:
        df_to_insert.write.format("delta").mode("append").saveAsTable(TARGET_GOLDEN)

    print(f"After SCD2 merge — total rows: {spark.table(TARGET_GOLDEN).count():,}")
    print(f"  Current rows: {spark.table(TARGET_GOLDEN).filter(col('is_current') == True).count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Review queue — `lh_gold.party_review_queue`
# MAGIC
# MAGIC Probabilistic matches with score in `[0.78, 0.92)` are *not* auto-merged. They go to a steward
# MAGIC review queue with the candidate pair, the score, and the standardized fields so a human can
# MAGIC make the call. This pattern matches the doc's "Stewardship & Override Workflow" section.

# COMMAND ----------

review_pairs = prob_review.select("rid_a", "rid_b", "match_score", "match_tier")

df_records_min = df_std.select(
    col("record_id"), col("source_system"), col("source_record_id"),
    col("first_norm"), col("last_norm"), col("email_norm"), col("phone_norm"),
    col("dob"), col("address_line1"),
)

review_enriched = (
    review_pairs
    .join(df_records_min.alias("a"), col("rid_a") == col("a.record_id"))
    .join(df_records_min.alias("b"), col("rid_b") == col("b.record_id"))
    .select(
        col("rid_a"), col("rid_b"), col("match_score"), col("match_tier"),
        col("a.source_system").alias("a_source_system"),
        col("a.source_record_id").alias("a_source_record_id"),
        col("a.first_norm").alias("a_first"), col("a.last_norm").alias("a_last"),
        col("a.email_norm").alias("a_email"), col("a.phone_norm").alias("a_phone"),
        col("a.dob").alias("a_dob"), col("a.address_line1").alias("a_address"),
        col("b.source_system").alias("b_source_system"),
        col("b.source_record_id").alias("b_source_record_id"),
        col("b.first_norm").alias("b_first"), col("b.last_norm").alias("b_last"),
        col("b.email_norm").alias("b_email"), col("b.phone_norm").alias("b_phone"),
        col("b.dob").alias("b_dob"), col("b.address_line1").alias("b_address"),
    )
    .withColumn("status", lit("PENDING_STEWARD"))
    .withColumn("_queued_timestamp", current_timestamp())
    .withColumn("_batch_id", lit(batch_id))
)

review_enriched.write.format("delta").mode("overwrite") \
    .option("overwriteSchema", "true").saveAsTable(TARGET_REVIEW)
print(f"Wrote {TARGET_REVIEW}: {spark.table(TARGET_REVIEW).count():,} pending decisions")

# COMMAND ----------

# MAGIC %md
# MAGIC ## MDM quality metrics — `lh_gold.mdm_quality_metrics`
# MAGIC
# MAGIC Track the doc's "MDM Quality Metrics" subset that we can compute deterministically:
# MAGIC
# MAGIC | Metric | Formula |
# MAGIC |---|---|
# MAGIC | `match_coverage` | records-in-cluster-size>1 / total records |
# MAGIC | `auto_merge_rate` | (deterministic + auto-prob pairs) / (auto + review pairs) |
# MAGIC | `review_queue_size` | count of pending pairs |
# MAGIC | `golden_record_completeness` | mean non-null pct of tracked attributes |
# MAGIC | `total_clusters` / `multi_record_clusters` | cluster sizing |
# MAGIC | `total_master_ids` | distinct masters in the current golden snapshot |

# COMMAND ----------

# match_coverage
records_in_multirecord_clusters = (
    df_clusters.groupBy("cluster_id").count()
    .filter(col("count") > 1)
    .agg(spark_sum("count")).collect()[0][0] or 0
)
match_coverage = records_in_multirecord_clusters / total_records if total_records else 0.0

# auto_merge_rate
auto_pair_count = det_count + prob_auto_count
total_classified_pairs = auto_pair_count + prob_review_count
auto_merge_rate = (auto_pair_count / total_classified_pairs) if total_classified_pairs else 1.0

# completeness — mean non-null pct of (first_name, last_name, email, phone, dob, address_line1) on current golden
current_golden = spark.table(TARGET_GOLDEN).filter(col("is_current") == True)  # noqa: E712
total_master_ids = current_golden.count()
attr_check = ["first_name", "last_name", "email", "phone", "dob", "address_line1"]
if total_master_ids > 0:
    non_null_pcts = []
    for a in attr_check:
        non_null = current_golden.filter(col(a).isNotNull()).count()
        non_null_pcts.append(non_null / total_master_ids)
    completeness = sum(non_null_pcts) / len(non_null_pcts)
else:
    completeness = 0.0

metrics_row = Row(
    batch_id=batch_id,
    metric_timestamp=datetime.now(),
    total_source_records=int(total_records),
    total_clusters=int(cluster_count),
    multi_record_clusters=int(multi_record_clusters),
    total_master_ids=int(total_master_ids),
    match_coverage=float(match_coverage),
    deterministic_pairs=int(det_count),
    probabilistic_auto_pairs=int(prob_auto_count),
    probabilistic_review_pairs=int(prob_review_count),
    auto_merge_rate=float(auto_merge_rate),
    review_queue_size=int(prob_review_count),
    golden_record_completeness=float(completeness),
    used_rapidfuzz=bool(_HAS_RAPIDFUZZ),
)

df_metrics = spark.createDataFrame([metrics_row])

if spark.catalog.tableExists(TARGET_METRICS):
    df_metrics.write.format("delta").mode("append").saveAsTable(TARGET_METRICS)
else:
    df_metrics.write.format("delta").mode("overwrite") \
        .option("overwriteSchema", "true").saveAsTable(TARGET_METRICS)

print(f"Wrote metrics row to {TARGET_METRICS}")
df_metrics.show(truncate=False, vertical=True)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation summary
# MAGIC
# MAGIC A few final SQL checks to verify the pipeline produced sane results.

# COMMAND ----------

print("=== party_xref by source ===")
spark.sql(f"""
    SELECT source_system, COUNT(*) AS rows, COUNT(DISTINCT cluster_id) AS clusters
    FROM {TARGET_XREF}
    GROUP BY source_system
    ORDER BY source_system
""").show()

print("=== party_xref by match_tier ===")
spark.sql(f"""
    SELECT match_tier, COUNT(*) AS rows
    FROM {TARGET_XREF}
    GROUP BY match_tier
    ORDER BY rows DESC
""").show()

print("=== party_golden current snapshot ===")
spark.sql(f"""
    SELECT
        COUNT(*) AS current_master_records,
        ROUND(AVG(record_count), 2) AS avg_records_per_cluster,
        MAX(record_count) AS max_records_per_cluster,
        ROUND(AVG(confidence_score), 3) AS avg_confidence
    FROM {TARGET_GOLDEN}
    WHERE is_current = true
""").show()

print("=== Top 10 largest clusters ===")
spark.sql(f"""
    SELECT master_id, cluster_id, record_count, first_name, last_name, email, confidence_score
    FROM {TARGET_GOLDEN}
    WHERE is_current = true
    ORDER BY record_count DESC
    LIMIT 10
""").show(truncate=False)

print("=== Survivorship rule provenance sample ===")
spark.sql(f"""
    SELECT master_id, first_name, first_name_rule, email, email_rule,
           phone, phone_rule, dob, dob_rule
    FROM {TARGET_GOLDEN}
    WHERE is_current = true
    LIMIT 5
""").show(truncate=False)

print("=== Review queue sample ===")
spark.sql(f"""
    SELECT match_score, a_source_system, a_first, a_last,
           b_source_system, b_first, b_last
    FROM {TARGET_REVIEW}
    ORDER BY match_score DESC
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Delta tables for Direct Lake / consumer queries

# COMMAND ----------

for tbl in [TARGET_GOLDEN, TARGET_XREF, TARGET_REVIEW, TARGET_METRICS]:
    try:
        spark.sql(f"OPTIMIZE {tbl}")
        print(f"OPTIMIZE {tbl} - done")
    except Exception as e:  # OPTIMIZE may be a no-op on tiny tables
        print(f"OPTIMIZE {tbl} skipped: {e}")

try:
    spark.sql(f"OPTIMIZE {TARGET_GOLDEN} ZORDER BY (master_id, is_current)")
    print(f"Z-Ordered {TARGET_GOLDEN} on (master_id, is_current)")
except Exception as e:
    print(f"Z-Order skipped: {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cleanup — uncache cached DataFrames

# COMMAND ----------

for df in [df_std, deterministic_pairs, df_scored]:
    try:
        df.unpersist()
    except Exception:
        pass
print("Caches released.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Notebook exit — surface summary to pipeline orchestrator

# COMMAND ----------

summary = (
    f"batch={batch_id} "
    f"records={total_records} "
    f"clusters={cluster_count} "
    f"multi_record_clusters={multi_record_clusters} "
    f"masters={total_master_ids} "
    f"match_coverage={match_coverage:.3f} "
    f"auto_merge_rate={auto_merge_rate:.3f} "
    f"review_queue={prob_review_count} "
    f"completeness={completeness:.3f}"
)
print(summary)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Production hardening notes
# MAGIC
# MAGIC When promoting this pattern from POC to production, follow the doc's
# MAGIC **Production Readiness Checklist**:
# MAGIC
# MAGIC 1. **Replace driver Union-Find with GraphFrames `connectedComponents`** — driver-side UF
# MAGIC    breaks past ~10M records.
# MAGIC 2. **Move survivorship to `groupBy().applyInPandas()`** — current pandas-on-driver works for
# MAGIC    POC scale only.
# MAGIC 3. **Layer steward overrides last** — read `lh_gold.party_steward_overrides` and apply on
# MAGIC    top of algorithmic survivorship (overrides always win).
# MAGIC 4. **Schedule re-clustering** — daily for transactional sources; trigger on bulk Compliance load.
# MAGIC 5. **Add watch-list / sanctions screening** against `lh_gold.party_golden`, not raw sources
# MAGIC    (catches alias attempts).
# MAGIC 6. **Version every cluster change** — write a `(master_id, cluster_version, change_type)`
# MAGIC    audit row when clusters split or merge.
# MAGIC 7. **Wire to Power BI** — a `mdm_quality_dashboard.pbix` should pin all 9 metrics from the
# MAGIC    anchor doc to a leadership scorecard.
# MAGIC 8. **PII** — verify `ssn_hash` is the only SSN form anywhere in the pipeline. Add a
# MAGIC    `great_expectations` suite asserting "no clear-text 9-digit-SSN-shaped strings exist".

_notebook_exit(summary)
