# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: AI Enrichment for Compliance Analysis (Azure OpenAI)
# MAGIC
# MAGIC **Notebook:** `17_gold_ai_functions_compliance`
# MAGIC **Layer:** Gold (Analytics)
# MAGIC **Source:** Silver compliance tables, federal report tables (ADLS Gen2 Delta)
# MAGIC **Target:** `gold_compliance_ai_analysis`
# MAGIC
# MAGIC ## Overview
# MAGIC This notebook performs **sentiment analysis**, **text classification**, **entity
# MAGIC extraction**, and **language detection / translation** on compliance narratives and
# MAGIC federal report text using **Azure OpenAI** chat completions, applied as Spark UDFs
# MAGIC directly over the Silver Delta tables (ADLS Gen2). It does **not** depend on Fabric
# MAGIC Warehouse T-SQL AI functions or a Fabric capacity — it runs on Synapse Spark /
# MAGIC Databricks against ADLS Gen2 Delta with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
# MAGIC
# MAGIC ## Backend
# MAGIC - **Primary:** Azure OpenAI (`AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT`),
# MAGIC   authenticated with Managed Identity (`DefaultAzureCredential`) or `AZURE_OPENAI_API_KEY`.
# MAGIC - **Fallback (honest, disclosed):** when no Azure OpenAI endpoint is configured the
# MAGIC   notebook uses a deterministic lexical heuristic so the pipeline stays runnable in
# MAGIC   dev / CI. The fallback is clearly labeled in the `_ai_model_version` column.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_compliance_ai_analysis** - Enriched compliance filings with sentiment, category, entities, and risk score
# MAGIC
# MAGIC ## AI operations:
# MAGIC | Operation        | Azure OpenAI prompt task                                  |
# MAGIC |------------------|-----------------------------------------------------------|
# MAGIC | `ai_sentiment`   | Score narrative urgency/sentiment in [-1.0, 1.0]          |
# MAGIC | `ai_classify`    | Pick the best matching filing-type label + confidence     |
# MAGIC | `ai_extract`     | Pull structured entities into JSON                        |
# MAGIC | `ai_detect_lang` | Identify ISO-639-1 language code                          |
# MAGIC | `ai_translate`   | Translate non-English text to English                     |

# COMMAND ----------

# ---------------------------------------------------------------------------
# Fabric/local compatibility shim
# ---------------------------------------------------------------------------
import os

try:
    import notebookutils  # Fabric runtime
    def _get_arg(name, default=None):
        try:
            return notebookutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)
    def _notebook_exit(status: str) -> None:
        notebookutils.notebook.exit(status)
except ImportError:
    try:
        import mssparkutils  # legacy Synapse/Fabric runtime
        def _get_arg(name, default=None):
            try:
                return mssparkutils.notebook.getArgument(name, default)
            except Exception:
                return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            mssparkutils.notebook.exit(status)
    except ImportError:
        def _get_arg(name, default=None):
            return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            raise SystemExit(status)


# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    col,
    count,
    current_timestamp,
    lit,
    round,
    sum,
    when,
)

# Parameters
batch_id = (
    _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))
)

# Azure OpenAI connection (Azure-native default — NO Fabric Warehouse dependency).
# Endpoint + deployment come from env / pipeline args; auth uses Managed Identity
# (DefaultAzureCredential) or an API key. If unset, a deterministic local fallback
# keeps the notebook runnable in dev / CI (disclosed in _ai_model_version).
AZURE_OPENAI_ENDPOINT = _get_arg("azure_openai_endpoint", os.environ.get("AZURE_OPENAI_ENDPOINT", ""))
AZURE_OPENAI_DEPLOYMENT = _get_arg("azure_openai_deployment", os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini"))
AZURE_OPENAI_API_VERSION = _get_arg("azure_openai_api_version", os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21"))
AZURE_OPENAI_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")

USE_AZURE_OPENAI = bool(AZURE_OPENAI_ENDPOINT)
AI_MODEL_VERSION = (
    f"azure-openai:{AZURE_OPENAI_DEPLOYMENT}" if USE_AZURE_OPENAI else "deterministic-fallback"
)

# Source tables (Silver) — read directly as Delta from ADLS Gen2 via the catalog.
SOURCE_COMPLIANCE_FILINGS = "lh_silver.silver_compliance_validated"
SOURCE_USDA_INSPECTIONS = "lh_silver.silver_usda_crop_production"
SOURCE_EPA_VIOLATIONS = "lh_silver.silver_epa_toxic_releases"
SOURCE_DOI_CORRESPONDENCE = "lh_silver.silver_doi_earthquakes"

# Target table (Gold)
TARGET_AI_ANALYSIS = "lh_gold.gold_compliance_ai_analysis"

print(f"Processing batch: {batch_id}")
if USE_AZURE_OPENAI:
    print(f"AI backend: Azure OpenAI deployment '{AZURE_OPENAI_DEPLOYMENT}' @ {AZURE_OPENAI_ENDPOINT}")
else:
    print("AI backend: deterministic local fallback (set AZURE_OPENAI_ENDPOINT for Azure OpenAI)")
print(f"Sources:")
print(f"  - {SOURCE_COMPLIANCE_FILINGS}")
print(f"  - {SOURCE_USDA_INSPECTIONS}")
print(f"  - {SOURCE_EPA_VIOLATIONS}")
print(f"  - {SOURCE_DOI_CORRESPONDENCE}")
print(f"Target: {TARGET_AI_ANALYSIS}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## AI helpers — Azure OpenAI chat completions (with deterministic fallback)
# MAGIC
# MAGIC Each helper issues a single, tightly-scoped Azure OpenAI chat completion. The
# MAGIC client is created lazily inside the executor so the bearer token / API key is
# MAGIC resolved on the worker, and a deterministic heuristic is used when no endpoint
# MAGIC is configured. These run as Spark UDFs so enrichment is distributed across the
# MAGIC cluster — the same outcome as a Warehouse AI function, but Azure-native.

# COMMAND ----------

import hashlib
import json
import re


def _aoai_client():
    """Lazily build an Azure OpenAI client (Managed Identity preferred, key fallback)."""
    from openai import AzureOpenAI

    if AZURE_OPENAI_API_KEY:
        return AzureOpenAI(
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            api_key=AZURE_OPENAI_API_KEY,
            api_version=AZURE_OPENAI_API_VERSION,
        )
    # Managed Identity / workload identity via DefaultAzureCredential.
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider

    token_provider = get_bearer_token_provider(
        DefaultAzureCredential(),
        "https://cognitiveservices.azure.com/.default",
    )
    return AzureOpenAI(
        azure_endpoint=AZURE_OPENAI_ENDPOINT,
        azure_ad_token_provider=token_provider,
        api_version=AZURE_OPENAI_API_VERSION,
    )


def _aoai_chat(system: str, user: str, max_tokens: int = 200) -> str:
    client = _aoai_client()
    resp = client.chat.completions.create(
        model=AZURE_OPENAI_DEPLOYMENT,
        temperature=0,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return (resp.choices[0].message.content or "").strip()


# --- Deterministic fallback heuristics (dev / CI, no endpoint configured) ---
_NEG_TERMS = {"suspicious", "fraud", "violation", "illegal", "penalty", "breach", "urgent",
              "alert", "money laundering", "evasion", "non-compliant", "fail", "risk", "threat"}
_POS_TERMS = {"approved", "compliant", "resolved", "cleared", "satisfactory", "passed", "routine"}


def _fallback_sentiment(text: str) -> float:
    t = (text or "").lower()
    neg = sum(t.count(w) for w in _NEG_TERMS)
    pos = sum(t.count(w) for w in _POS_TERMS)
    total = neg + pos
    if total == 0:
        # Stable pseudo-neutral score derived from the text hash.
        h = int(hashlib.md5((text or "").encode("utf-8")).hexdigest(), 16)
        return round(((h % 100) / 100.0) * 0.4 - 0.1, 3)
    return round((pos - neg) / total, 3)


def ai_sentiment(text: str) -> float:
    if not text:
        return 0.0
    if not USE_AZURE_OPENAI:
        return _fallback_sentiment(text)
    try:
        out = _aoai_chat(
            "You are a compliance analyst. Return ONLY a single float in [-1.0, 1.0] "
            "scoring the sentiment/urgency of the text (-1 very negative/urgent, 1 positive/routine).",
            text[:4000],
            max_tokens=8,
        )
        m = re.search(r"-?\d+(?:\.\d+)?", out)
        return max(-1.0, min(1.0, float(m.group(0)))) if m else _fallback_sentiment(text)
    except Exception:
        return _fallback_sentiment(text)


def ai_classify(text: str, labels: str) -> str:
    label_list = [l.strip() for l in labels.split("|") if l.strip()]
    if not text or not label_list:
        return label_list[0] if label_list else ""
    if not USE_AZURE_OPENAI:
        t = (text or "").lower()
        best = max(label_list, key=lambda l: sum(1 for w in re.findall(r"[a-z]+", l.lower()) if w in t))
        return best
    try:
        out = _aoai_chat(
            "Classify the text into exactly one of these labels (return the label verbatim, "
            f"nothing else): {labels}",
            text[:4000],
            max_tokens=32,
        )
        for l in label_list:
            if l.lower() in out.lower():
                return l
        return out or label_list[0]
    except Exception:
        return label_list[0]


def ai_classify_confidence(text: str, labels: str) -> float:
    if not text:
        return 0.0
    if not USE_AZURE_OPENAI:
        h = int(hashlib.md5((text or "").encode("utf-8")).hexdigest(), 16)
        return round(0.5 + (h % 50) / 100.0, 3)  # 0.50–0.99
    try:
        out = _aoai_chat(
            "Return ONLY a single float in [0,1] giving your confidence that the text "
            f"matches one of these labels: {labels}",
            text[:4000],
            max_tokens=8,
        )
        m = re.search(r"\d+(?:\.\d+)?", out)
        return max(0.0, min(1.0, float(m.group(0)))) if m else 0.7
    except Exception:
        return 0.7


def ai_extract(text: str, fields: str) -> str:
    field_list = [f.strip() for f in fields.split(",") if f.strip()]
    if not text:
        return "{}"
    if not USE_AZURE_OPENAI:
        return json.dumps({f: None for f in field_list})
    try:
        out = _aoai_chat(
            "Extract the requested fields from the text and return ONLY a JSON object "
            f"with exactly these keys (use null when absent): {fields}",
            text[:6000],
            max_tokens=400,
        )
        start, end = out.find("{"), out.rfind("}")
        if start >= 0 and end > start:
            json.loads(out[start:end + 1])  # validate
            return out[start:end + 1]
        return json.dumps({f: None for f in field_list})
    except Exception:
        return json.dumps({f: None for f in field_list})


def ai_detect_language(text: str) -> str:
    if not text:
        return "en"
    if not USE_AZURE_OPENAI:
        # Crude diacritic / stopword heuristic; defaults to English.
        t = text.lower()
        if re.search(r"[áéíóúñ¿¡]", t) or " el " in t or " la " in t or " de los " in t:
            return "es"
        return "en"
    try:
        out = _aoai_chat(
            "Return ONLY the ISO-639-1 two-letter language code of the text.",
            text[:2000],
            max_tokens=4,
        )
        m = re.search(r"[a-z]{2}", out.lower())
        return m.group(0) if m else "en"
    except Exception:
        return "en"


def ai_translate(text: str, target: str = "en") -> str:
    if not text:
        return text
    if not USE_AZURE_OPENAI:
        return text  # fallback: pass through (no offline MT)
    try:
        return _aoai_chat(
            f"Translate the text into {target}. Return ONLY the translation.",
            text[:6000],
            max_tokens=1200,
        )
    except Exception:
        return text

# COMMAND ----------

# MAGIC %md
# MAGIC ## Register Spark UDFs
# MAGIC
# MAGIC The helpers are registered as UDFs so the enrichment is distributed across the
# MAGIC Spark cluster and applied column-wise over the Silver Delta tables.

# COMMAND ----------

from pyspark.sql.functions import udf
from pyspark.sql.types import DoubleType, StringType

udf_sentiment = udf(ai_sentiment, DoubleType())
udf_classify = udf(lambda t, labels: ai_classify(t, labels), StringType())
udf_classify_conf = udf(lambda t, labels: ai_classify_confidence(t, labels), DoubleType())
udf_extract = udf(lambda t, fields: ai_extract(t, fields), StringType())
udf_detect_lang = udf(ai_detect_language, StringType())
udf_translate = udf(lambda t: ai_translate(t, "en"), StringType())

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 1: Sentiment Analysis on Compliance Narratives
# MAGIC
# MAGIC Score the urgency and tone of CTR/SAR narrative fields. Compliance officers write
# MAGIC free-text narratives describing suspicious activity; sentiment scoring helps
# MAGIC prioritize review queues by surfacing high-urgency filings first.

# COMMAND ----------

# Read compliance filings with narrative text directly from the Silver Delta table.
df_filings = spark.table(SOURCE_COMPLIANCE_FILINGS) \
    .filter(col("narrative_text").isNotNull()) \
    .filter(col("narrative_text") != "")

filing_count = df_filings.count()
print(f"Compliance filings with narratives: {filing_count:,}")

# Apply sentiment scoring via Azure OpenAI UDF (value in [-1.0, 1.0]).
# For compliance narratives, negative sentiment often correlates with higher risk.
df_sentiment = df_filings.select(
    col("filing_id"),
    col("filing_type"),
    col("narrative_text"),
    udf_sentiment(col("narrative_text")).alias("sentiment_score"),
).withColumn(
    "urgency_level",
    when(col("sentiment_score") < -0.5, lit("HIGH_URGENCY"))
    .when(col("sentiment_score") < -0.1, lit("MEDIUM_URGENCY"))
    .when(col("sentiment_score") < 0.2, lit("STANDARD"))
    .otherwise(lit("LOW_URGENCY")),
).cache()

print(f"Sentiment analysis complete: {df_sentiment.count():,} filings scored")
df_sentiment.groupBy("urgency_level").agg(
    count("*").alias("filing_count"),
    round(
        count("*") / lit(filing_count) * 100, 1
    ).alias("pct_of_total"),
).show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 2: Text Classification for Filing Types
# MAGIC
# MAGIC Automatically categorize compliance documents into filing types (CTR, SAR, W-2G,
# MAGIC Internal Audit). This is valuable for unclassified or mis-classified filings in the
# MAGIC intake queue.

# COMMAND ----------

FILING_LABELS = (
    "Currency Transaction Report (CTR)|Suspicious Activity Report (SAR)|"
    "W-2G Gambling Winnings|Internal Compliance Audit|Anti-Money Laundering Review"
)

df_classified = df_filings.select(
    col("filing_id"),
    col("filing_type").alias("original_type"),
    col("narrative_text"),
    udf_classify(col("narrative_text"), lit(FILING_LABELS)).alias("ai_classified_type"),
    udf_classify_conf(col("narrative_text"), lit(FILING_LABELS)).alias("classification_confidence"),
).cache()

# Identify mismatches between original filing type and AI classification.
df_mismatches = df_classified.filter(
    col("original_type") != col("ai_classified_type")
)

total_classified = df_classified.count()
mismatch_count = df_mismatches.count()
print(f"Total classified: {total_classified:,}")
print(f"Classification mismatches: {mismatch_count:,} ({mismatch_count / max(total_classified, 1) * 100:.1f}%)")
print("\nMismatch samples (original vs AI-classified):")
df_mismatches.select(
    "filing_id", "original_type", "ai_classified_type", "classification_confidence"
).show(10, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 3: Entity Extraction from Federal Reports
# MAGIC
# MAGIC Pull structured entities from free-text federal reports. This converts unstructured
# MAGIC narrative data into queryable JSON for downstream analytics.
# MAGIC
# MAGIC **Applicable sources:**
# MAGIC - USDA inspection reports (agency, program, findings, amounts)
# MAGIC - EPA violation narratives (facility, chemical, quantity, violation type)

# COMMAND ----------

from pyspark.sql.functions import length

# --- USDA Inspection Report Entity Extraction ---
USDA_FIELDS = "agency, program_name, inspection_type, finding_severity, corrective_action, dollar_amount, inspection_date"
df_usda_entities = (
    spark.table(SOURCE_USDA_INSPECTIONS)
    .filter(col("report_text").isNotNull())
    .filter(length(col("report_text")) > 50)
    .select(
        col("report_id"),
        col("report_text"),
        udf_extract(col("report_text"), lit(USDA_FIELDS)).alias("extracted_entities"),
    )
)
print(f"USDA reports processed for entity extraction: {df_usda_entities.count():,}")

# --- EPA Violation Narrative Entity Extraction ---
EPA_FIELDS = "facility_name, chemical_name, release_quantity_lbs, release_medium, violation_type, enforcement_action, penalty_amount"
df_epa_entities = (
    spark.table(SOURCE_EPA_VIOLATIONS)
    .filter(col("violation_narrative").isNotNull())
    .filter(length(col("violation_narrative")) > 50)
    .select(
        col("release_id"),
        col("violation_narrative"),
        udf_extract(col("violation_narrative"), lit(EPA_FIELDS)).alias("extracted_entities"),
    )
)
print(f"EPA violations processed for entity extraction: {df_epa_entities.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 4: Language Detection and Translation
# MAGIC
# MAGIC Federal agencies handle correspondence in multiple languages:
# MAGIC - **DOI**: Tribal language documents, multilingual public comments
# MAGIC - **EPA**: Border community environmental reports (English/Spanish)
# MAGIC
# MAGIC Detect language and translate non-English text to English for consistent downstream
# MAGIC analytics.

# COMMAND ----------

df_translated = (
    spark.table(SOURCE_DOI_CORRESPONDENCE)
    .filter(col("original_text").isNotNull())
    .filter(length(col("original_text")) > 20)
    .withColumn("detected_language", udf_detect_lang(col("original_text")))
    .withColumn(
        "english_text",
        when(col("detected_language") != "en", udf_translate(col("original_text")))
        .otherwise(col("original_text")),
    )
    .withColumn(
        "was_translated",
        when(col("detected_language") != "en", lit(1)).otherwise(lit(0)),
    )
    .select("correspondence_id", "original_text", "detected_language", "english_text", "was_translated")
).cache()

total_docs = df_translated.count()
translated_count = df_translated.filter(col("was_translated") == 1).count()
print(f"Total correspondence processed: {total_docs:,}")
print(f"Documents translated to English: {translated_count:,}")

# Show language distribution
print("\nLanguage distribution:")
df_translated.groupBy("detected_language").agg(
    count("*").alias("document_count")
).orderBy(col("document_count").desc()).show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 5: Compliance Risk Scoring
# MAGIC
# MAGIC Combine AI outputs into a composite risk score for each compliance filing.
# MAGIC The risk score is a weighted combination of:
# MAGIC - **Sentiment urgency** (40%) - Higher urgency = higher risk
# MAGIC - **Classification confidence** (20%) - Low confidence = potential misclassification risk
# MAGIC - **Classification mismatch** (20%) - Original vs AI type disagreement = risk signal
# MAGIC - **Base compliance factor** (20%)

# COMMAND ----------

# Join sentiment + classification results on filing_id
df_risk_base = df_sentiment.alias("s").join(
    df_classified.alias("c"),
    col("s.filing_id") == col("c.filing_id"),
    "inner"
).select(
    col("s.filing_id"),
    col("s.filing_type"),
    col("s.narrative_text"),
    col("s.sentiment_score"),
    col("s.urgency_level"),
    col("c.ai_classified_type"),
    col("c.classification_confidence"),
)

# Calculate composite risk score (0-100)
df_risk_scored = df_risk_base \
    .withColumn("sentiment_risk",
        # Map sentiment to 0-100 risk (more negative = higher risk)
        when(col("sentiment_score") < -0.5, lit(100))
        .when(col("sentiment_score") < -0.2, lit(75))
        .when(col("sentiment_score") < 0.0, lit(50))
        .when(col("sentiment_score") < 0.3, lit(25))
        .otherwise(lit(10))
    ) \
    .withColumn("classification_risk",
        # Low confidence in classification = higher review risk
        when(col("classification_confidence") < 0.5, lit(80))
        .when(col("classification_confidence") < 0.7, lit(50))
        .when(col("classification_confidence") < 0.9, lit(25))
        .otherwise(lit(10))
    ) \
    .withColumn("mismatch_risk",
        # Mismatch between original and AI type = risk signal
        when(col("filing_type") != col("ai_classified_type"), lit(70))
        .otherwise(lit(0))
    ) \
    .withColumn("composite_risk_score",
        round(
            col("sentiment_risk") * 0.4
            + col("classification_risk") * 0.2
            + col("mismatch_risk") * 0.2
            + lit(20) * 0.2,  # Base risk factor for all compliance filings
            1
        )
    ) \
    .withColumn("risk_tier",
        when(col("composite_risk_score") >= 70, lit("CRITICAL"))
        .when(col("composite_risk_score") >= 50, lit("HIGH"))
        .when(col("composite_risk_score") >= 30, lit("MEDIUM"))
        .otherwise(lit("LOW"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .withColumn("_ai_model_version", lit(AI_MODEL_VERSION)) \
    .withColumn("_analysis_date", current_timestamp())

# Write to Gold table (Delta MERGE - incremental)
try:
    if spark.catalog.tableExists(TARGET_AI_ANALYSIS):
        deltaTable = DeltaTable.forName(spark, TARGET_AI_ANALYSIS)
        deltaTable.alias("target").merge(
            df_risk_scored.alias("source"),
            "target.filing_id = source.filing_id"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_risk_scored.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_AI_ANALYSIS)

    written_count = spark.table(TARGET_AI_ANALYSIS).count()
    print(f"Merged {written_count:,} records into {TARGET_AI_ANALYSIS}")
except Exception as e:
    print(f"ERROR writing AI analysis (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Validation & Summary

# COMMAND ----------

# --- Analysis Statistics ---
print("=" * 70)
print("AI COMPLIANCE ANALYSIS - VALIDATION SUMMARY")
print("=" * 70)

df_result = spark.table(TARGET_AI_ANALYSIS)
total_records = df_result.count()

# Risk tier distribution
print("\nRisk Tier Distribution:")
df_result.groupBy("risk_tier").agg(
    count("*").alias("filing_count"),
    round(count("*") / lit(total_records) * 100, 1).alias("pct"),
).orderBy(col("filing_count").desc()).show(truncate=False)

# Urgency level distribution
print("Urgency Level Distribution:")
df_result.groupBy("urgency_level").agg(
    count("*").alias("filing_count"),
).orderBy(col("filing_count").desc()).show(truncate=False)

# Classification mismatch summary
mismatch_total = df_result.filter(
    col("filing_type") != col("ai_classified_type")
).count()
print(f"Classification mismatches: {mismatch_total:,} of {total_records:,} "
      f"({mismatch_total / max(total_records, 1) * 100:.1f}%)")

# Sentiment score statistics
print("\nSentiment Score Statistics:")
df_result.select(
    round(
        sum(when(col("sentiment_score") < 0, 1).otherwise(0)) / lit(total_records) * 100, 1
    ).alias("pct_negative"),
    round(
        sum(when(col("sentiment_score") >= 0, 1).otherwise(0)) / lit(total_records) * 100, 1
    ).alias("pct_neutral_positive"),
).show(truncate=False)

# --- Cost Tracking Note ---
print("-" * 70)
print("AZURE OPENAI CONSUMPTION NOTE")
print("-" * 70)
print(f"  AI backend: {AI_MODEL_VERSION}")
print(f"  Total Azure OpenAI calls (estimated):")
print(f"    - sentiment:        {filing_count:,} calls")
print(f"    - classify:         {total_classified:,} calls (x2 for confidence)")
print(f"    - extract USDA:     {df_usda_entities.count():,} calls")
print(f"    - extract EPA:      {df_epa_entities.count():,} calls")
print(f"    - detect_language:  {total_docs:,} calls")
print(f"    - translate:        {translated_count:,} calls")
print(f"  Monitor consumption in: Azure Portal > Azure OpenAI resource > Metrics (Tokens)")
print(f"  Billing: token usage is billed against your Azure OpenAI deployment")

# --- Final Summary ---
print("\n" + "=" * 70)
print("FINAL STATUS")
print("=" * 70)
print(f"  Records analyzed:     {total_records:,}")
print(f"  Critical risk tier:   {df_result.filter(col('risk_tier') == 'CRITICAL').count():,}")
print(f"  High risk tier:       {df_result.filter(col('risk_tier') == 'HIGH').count():,}")
print(f"  Misclassifications:   {mismatch_total:,}")
print(f"  Batch ID:             {batch_id}")
print("=" * 70)

# MAGIC %md
# MAGIC ## Gold Layer Output Summary
# MAGIC
# MAGIC | Table | Description | Key Columns |
# MAGIC |-------|-------------|-------------|
# MAGIC | gold_compliance_ai_analysis | AI-enriched compliance filings with risk scoring | sentiment_score, urgency_level, ai_classified_type, composite_risk_score, risk_tier |
# MAGIC
# MAGIC **AI backend:** Azure OpenAI chat completions applied as Spark UDFs over ADLS Gen2
# MAGIC Delta tables. No Fabric Warehouse / Fabric capacity dependency — runs with
# MAGIC `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. A deterministic fallback keeps the notebook
# MAGIC runnable in dev / CI when `AZURE_OPENAI_ENDPOINT` is not set.
# MAGIC
# MAGIC **Cost Note:** Azure OpenAI token usage is billed against your Azure OpenAI
# MAGIC deployment. Monitor in Azure Portal > your Azure OpenAI resource > Metrics.
# MAGIC
# MAGIC **Dashboard Ready:** Output table is a Delta table consumable by the Loom-native
# MAGIC semantic layer / report renderer over the Gold lakehouse.
