# Databricks notebook source
# MAGIC %md
# MAGIC # RAG: Eventhouse Vector Database + Hybrid Retrieval + Reranking + Eval
# MAGIC
# MAGIC End-to-end **production RAG** pipeline over the casino compliance corpus
# MAGIC (BSA, AML, MICS, W-2G), demonstrating the patterns from
# MAGIC `docs/features/rag-patterns-deep-dive.md` and
# MAGIC `docs/features/eventhouse-vector-database.md`.
# MAGIC
# MAGIC ## Pipeline Stages
# MAGIC
# MAGIC 1. Synthetic compliance corpus (15-20 documents)
# MAGIC 2. Recursive chunking (chunk_size=512, overlap=64) with metadata
# MAGIC 3. Embedding (sentence-transformers / AOAI / deterministic mock fallback)
# MAGIC 4. Persist chunks + vectors to a Delta table that mirrors the Eventhouse
# MAGIC    `Vector16` schema (production would write to an Eventhouse KQL DB)
# MAGIC 5. Pure vector search (cosine) — top-K=10
# MAGIC 6. BM25 / TF-IDF lexical search — top-K=10
# MAGIC 7. Hybrid fusion via Reciprocal Rank Fusion (k=60)
# MAGIC 8. Reranking (cross-encoder if available; LLM-as-judge stub fallback)
# MAGIC 9. Generation (LLM call placeholder; templated context with citation IDs)
# MAGIC 10. Citation extraction + grounded-answer verification
# MAGIC 11. Evaluation harness — Recall@5, MRR, Faithfulness/Relevance stubs
# MAGIC 12. Persist eval results to `lh_gold.rag_eval_results` for trend tracking
# MAGIC 13. Production patterns — query cache, latency tracking, cost stub
# MAGIC
# MAGIC ## Related Docs
# MAGIC
# MAGIC - `docs/features/rag-patterns-deep-dive.md`
# MAGIC - `docs/features/eventhouse-vector-database.md`
# MAGIC - `docs/features/data-agents.md`
# MAGIC - `docs/features/fabric-iq.md`
# MAGIC
# MAGIC ## Notes
# MAGIC
# MAGIC - The notebook is **defensive**: if `sentence-transformers` is unavailable
# MAGIC   it falls back to a deterministic hashing embedder so the pipeline is
# MAGIC   always runnable.
# MAGIC - LLM generation calls are **stubbed** — wire to AOAI/Anthropic via your
# MAGIC   workspace secret store (do **not** hard-code keys).

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

import hashlib
import json
import math
import os
import re
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from pyspark.sql import Row
from pyspark.sql.functions import col, current_timestamp, lit
from pyspark.sql.types import (
    ArrayType,
    DoubleType,
    FloatType,
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Optional: sentence-transformers for real embeddings + cross-encoder reranking
try:
    from sentence_transformers import CrossEncoder, SentenceTransformer
    _ST_AVAILABLE = True
except ImportError:  # pragma: no cover - environment-dependent
    SentenceTransformer = None  # type: ignore[assignment]
    CrossEncoder = None  # type: ignore[assignment]
    _ST_AVAILABLE = False

# MLflow optional — used for run tracking when present
try:
    import mlflow
    _MLFLOW_AVAILABLE = True
except ImportError:  # pragma: no cover
    mlflow = None  # type: ignore[assignment]
    _MLFLOW_AVAILABLE = False

# Fabric utility helper (safe no-op if running outside Fabric)
try:
    import notebookutils  # type: ignore[import-not-found]
    _MSSU = notebookutils.mssparkutils
except Exception:  # pragma: no cover
    _MSSU = None

EMBED_DIM_FALLBACK = 384      # Match all-MiniLM-L6-v2
VECTOR_TABLE = "lh_silver.kb_compliance_chunks"
EVAL_TABLE = "lh_gold.rag_eval_results"

print(f"sentence-transformers available: {_ST_AVAILABLE}")
print(f"mlflow available:                {_MLFLOW_AVAILABLE}")
print(f"target vector table:             {VECTOR_TABLE}")
print(f"target eval table:               {EVAL_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Synthetic Compliance Corpus
# MAGIC
# MAGIC We build ~18 short documents covering BSA CTR thresholds, SAR triggers,
# MAGIC NIGC MICS controls, and W-2G withholding rules. In production these
# MAGIC would be parsed PDFs / DOCX / HTML stored in OneLake.

# COMMAND ----------

CORPUS: List[Dict[str, Any]] = [
    {
        "doc_id": "BSA-CTR-001",
        "title": "Currency Transaction Report (CTR) Threshold",
        "source": "31 CFR 1010.311",
        "section": "Reporting Requirements",
        "content": (
            "A casino must file a Currency Transaction Report (CTR) for each "
            "transaction in currency of more than $10,000 by, through, or to "
            "the casino. Multiple currency transactions by or on behalf of any "
            "person on the same gaming day are aggregated. The report is filed "
            "with FinCEN within 15 calendar days following the day of the "
            "reportable transaction."
        ),
    },
    {
        "doc_id": "BSA-CTR-002",
        "title": "CTR Aggregation Rule",
        "source": "FinCEN Casino Guidance",
        "section": "Aggregation",
        "content": (
            "Cash-in and cash-out transactions are aggregated separately, not "
            "netted. If a patron buys $6,000 in chips at 10:00 AM and another "
            "$5,500 at 6:00 PM on the same gaming day, both cash-in events "
            "aggregate to $11,500, exceeding the $10,000 threshold and "
            "triggering a CTR."
        ),
    },
    {
        "doc_id": "BSA-SAR-001",
        "title": "Suspicious Activity Report (SAR) Triggers",
        "source": "31 CFR 1021.320",
        "section": "Suspicious Activity",
        "content": (
            "A casino must file a SAR for any transaction or pattern of "
            "transactions involving $5,000 or more (in aggregate) where the "
            "casino knows, suspects, or has reason to suspect that the "
            "transaction involves funds derived from illegal activity, is "
            "designed to evade BSA reporting, has no apparent lawful purpose, "
            "or facilitates criminal activity."
        ),
    },
    {
        "doc_id": "BSA-SAR-002",
        "title": "Structuring Detection Patterns",
        "source": "FinCEN Advisory",
        "section": "Structuring",
        "content": (
            "Structuring is the practice of breaking up cash transactions to "
            "stay below the $10,000 CTR threshold. Common patterns include "
            "multiple buy-ins of $8,000-$9,900 by the same patron within a "
            "gaming day, splitting transactions across cages, or using "
            "associates to deposit just under the threshold. All structuring "
            "behavior must be filed on a SAR regardless of intent."
        ),
    },
    {
        "doc_id": "BSA-SAR-003",
        "title": "SAR Filing Timeline",
        "source": "31 CFR 1021.320(b)",
        "section": "Filing Timeline",
        "content": (
            "A SAR must be filed no later than 30 calendar days after the date "
            "of initial detection of facts that may constitute a basis for "
            "filing. If no suspect is identified initially, an additional 30 "
            "days (60 total) is permitted. SARs are filed electronically with "
            "FinCEN via the BSA E-Filing System."
        ),
    },
    {
        "doc_id": "MICS-COMP-001",
        "title": "NIGC MICS - Compliance Officer Requirements",
        "source": "25 CFR 542 - MICS",
        "section": "Compliance Personnel",
        "content": (
            "Tribal gaming operations must designate a BSA Compliance Officer "
            "responsible for ensuring day-to-day compliance with the Bank "
            "Secrecy Act program. The officer must be sufficiently senior, "
            "independent of business operations, and have authority to enforce "
            "the program. Annual training is required for all employees with "
            "BSA reporting responsibilities."
        ),
    },
    {
        "doc_id": "MICS-CAGE-001",
        "title": "MICS Cage and Vault Controls",
        "source": "25 CFR 542.7",
        "section": "Cage Operations",
        "content": (
            "All cage transactions involving currency must be recorded with a "
            "unique transaction identifier, cashier ID, patron ID where "
            "available, timestamp, and dollar amount. Two-person verification "
            "is required for transactions over $3,000. Surveillance must "
            "monitor the cage continuously, and recordings are retained for a "
            "minimum of 7 days for routine activity, 5 years for SAR-related."
        ),
    },
    {
        "doc_id": "MICS-SLOT-001",
        "title": "MICS Slot Machine Drop and Count",
        "source": "25 CFR 542.13",
        "section": "Slot Operations",
        "content": (
            "Slot machine drop must be performed on a documented schedule with "
            "at least three independent observers — typically two security "
            "personnel and one accounting representative. The count room must "
            "have continuous surveillance and dual-control access. Variances "
            "of more than $200 between meter readings and counted currency "
            "require investigation and documentation."
        ),
    },
    {
        "doc_id": "MICS-SURV-001",
        "title": "MICS Surveillance Standards",
        "source": "25 CFR 542.10",
        "section": "Surveillance",
        "content": (
            "Surveillance must provide continuous monitoring of all gaming "
            "areas, count rooms, cages, and entrances/exits to those areas. "
            "All surveillance recordings are retained for at least 7 days; "
            "recordings related to investigations, incidents, or SAR filings "
            "are preserved indefinitely. Surveillance personnel must be "
            "independent of gaming operations management."
        ),
    },
    {
        "doc_id": "W2G-001",
        "title": "W-2G Reporting Thresholds by Game",
        "source": "IRS Publication 3908",
        "section": "Withholding Thresholds",
        "content": (
            "Form W-2G reports certain gambling winnings to the IRS. "
            "Thresholds vary by game type: slot machine and bingo winnings "
            "of $1,200 or more; keno winnings of $1,500 or more (net of wager); "
            "poker tournament winnings of more than $5,000 (net of buy-in); "
            "and any other gambling winnings of $600 or more, where winnings "
            "are at least 300 times the wager."
        ),
    },
    {
        "doc_id": "W2G-002",
        "title": "W-2G Backup Withholding",
        "source": "IRC Section 3406",
        "section": "Withholding",
        "content": (
            "If a winner does not provide a valid Taxpayer Identification "
            "Number, the casino must apply 24 percent backup withholding to "
            "reportable winnings. Regular gambling withholding of 24 percent "
            "applies to winnings over $5,000 from sweepstakes, lotteries, and "
            "wagering pools when the proceeds exceed 300 times the wager."
        ),
    },
    {
        "doc_id": "W2G-003",
        "title": "Aggregation of Multiple Wins",
        "source": "IRS Notice 2015-21",
        "section": "Aggregation",
        "content": (
            "For slot machines, each individual play is treated as a separate "
            "transaction; winnings are not aggregated across plays. For "
            "tournament play, the W-2G is issued for the net winnings (prize "
            "minus buy-in). For table game jackpots tied to side bets, the "
            "side-bet winnings are reported when the $600/300x rule applies."
        ),
    },
    {
        "doc_id": "AML-KYC-001",
        "title": "Know Your Customer for High-Value Patrons",
        "source": "FinCEN Casino BSA/AML Manual",
        "section": "Customer Due Diligence",
        "content": (
            "Casinos must implement risk-based customer due diligence for "
            "patrons whose cumulative cash-in or cash-out exceeds $50,000 in "
            "a 12-month period. CDD includes verifying identity with a "
            "government-issued photo ID, capturing source-of-funds attestation, "
            "and screening against OFAC, PEP, and adverse-media lists at "
            "enrollment and annually."
        ),
    },
    {
        "doc_id": "AML-OFAC-001",
        "title": "OFAC Sanctions Screening",
        "source": "31 CFR 501",
        "section": "Sanctions",
        "content": (
            "All casino patrons must be screened against the OFAC Specially "
            "Designated Nationals (SDN) list at account opening, before any "
            "reportable transaction, and on a continuous basis as the SDN "
            "list updates. Hits require immediate transaction freeze, blocked "
            "asset reporting within 10 days, and suspension of services until "
            "OFAC clearance is obtained."
        ),
    },
    {
        "doc_id": "AML-MARKER-001",
        "title": "Marker (Casino Credit) Controls",
        "source": "MICS 542.7 + Internal Policy",
        "section": "Markers",
        "content": (
            "Casino credit (markers) issued in excess of $10,000 in a gaming "
            "day must be aggregated for CTR purposes when the marker is paid "
            "down with currency. Marker issuance requires patron credit "
            "evaluation, approval by a credit officer for limits exceeding "
            "$25,000, and disclosure of redemption terms. Unpaid markers "
            "outstanding 90+ days are escalated to legal collection."
        ),
    },
    {
        "doc_id": "AML-WIRE-001",
        "title": "Wire Transfer and Funds Transmittal Rules",
        "source": "31 CFR 1010.410",
        "section": "Funds Transmittal",
        "content": (
            "For wire transfers of $3,000 or more, the casino must record the "
            "name and address of the originator, the amount, the execution "
            "date, payment instructions, the identity of the recipient "
            "financial institution, and the account number of the recipient. "
            "Records are retained for 5 years and provided to law enforcement "
            "upon lawful request."
        ),
    },
    {
        "doc_id": "BSA-PROG-001",
        "title": "BSA Compliance Program Five Pillars",
        "source": "31 CFR 1021.210",
        "section": "Program Elements",
        "content": (
            "A casino BSA compliance program must include: (1) a system of "
            "internal controls; (2) independent testing of compliance by "
            "qualified personnel; (3) designation of a BSA Compliance Officer; "
            "(4) ongoing training of appropriate personnel; and (5) risk-based "
            "customer due diligence procedures. The program must be approved "
            "in writing by the casino's board of directors or equivalent."
        ),
    },
    {
        "doc_id": "BSA-RECORD-001",
        "title": "Record Retention Requirements",
        "source": "31 CFR 1010.430",
        "section": "Records",
        "content": (
            "All BSA records — CTRs, SARs, currency logs, customer "
            "identification records, OFAC screening results — must be retained "
            "for 5 years from the date of the report or from the closing of "
            "the customer relationship, whichever is later. Records must be "
            "produced to FinCEN, IRS, or law enforcement within the time "
            "specified in any lawful request."
        ),
    },
]

print(f"Loaded {len(CORPUS)} compliance documents.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Recursive Chunking with Metadata
# MAGIC
# MAGIC We use a simple recursive splitter (paragraph → sentence → word) targeting
# MAGIC 512 tokens with 64-token overlap. Each chunk inherits the parent
# MAGIC `doc_id`, `title`, `source`, and `section`, plus a unique `chunk_id`.
# MAGIC
# MAGIC Per the deep-dive doc, we **prepend the document title and section** to
# MAGIC each chunk before embedding (typically lifts recall@10 by 3-7 percent).

# COMMAND ----------

def _approx_token_count(text: str) -> int:
    """Cheap approx: ~1.3 tokens per whitespace-separated word."""
    return max(1, int(len(text.split()) * 1.3))


def recursive_chunk(
    text: str,
    max_tokens: int = 512,
    overlap_tokens: int = 64,
    separators: Optional[List[str]] = None,
) -> List[str]:
    """Recursive splitter that respects paragraph/sentence boundaries."""
    if separators is None:
        separators = ["\n\n", "\n", ". ", " ", ""]

    if _approx_token_count(text) <= max_tokens:
        return [text]

    for sep in separators:
        if sep == "":
            words = text.split()
            step = max(1, max_tokens - overlap_tokens)
            return [" ".join(words[i:i + max_tokens]) for i in range(0, len(words), step)]
        parts = text.split(sep)
        if len(parts) <= 1:
            continue
        chunks: List[str] = []
        current = ""
        for part in parts:
            candidate = current + (sep if current else "") + part
            if _approx_token_count(candidate) <= max_tokens:
                current = candidate
                continue
            if current:
                chunks.append(current)
            if _approx_token_count(part) > max_tokens:
                chunks.extend(recursive_chunk(part, max_tokens, overlap_tokens, separators))
                current = ""
            else:
                current = part
        if current:
            chunks.append(current)

        # Add overlap by prepending last N words of previous chunk
        if overlap_tokens > 0 and len(chunks) > 1:
            with_overlap = [chunks[0]]
            for prev, curr in zip(chunks[:-1], chunks[1:]):
                tail = " ".join(prev.split()[-overlap_tokens:])
                with_overlap.append(f"{tail} {curr}")
            chunks = with_overlap
        return chunks
    return [text]


def build_chunks(corpus: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for doc in corpus:
        pieces = recursive_chunk(doc["content"], max_tokens=512, overlap_tokens=64)
        for idx, piece in enumerate(pieces):
            # Prepend title + section for embedding context
            embed_text = f"{doc['title']} | {doc['section']}\n{piece}"
            rows.append({
                "chunk_id": f"{doc['doc_id']}::chunk-{idx:02d}",
                "doc_id": doc["doc_id"],
                "title": doc["title"],
                "source": doc["source"],
                "section": doc["section"],
                "chunk_index": idx,
                "content": piece,
                "embed_text": embed_text,
                "token_count": _approx_token_count(piece),
            })
    return rows


chunks = build_chunks(CORPUS)
print(f"Produced {len(chunks)} chunks from {len(CORPUS)} documents.")
print(f"Avg tokens/chunk: {np.mean([c['token_count'] for c in chunks]):.1f}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Embedding Layer — Multi-Tier Fallback
# MAGIC
# MAGIC **Tier 1**: `sentence-transformers/all-MiniLM-L6-v2` (384-dim, runs on CPU).
# MAGIC
# MAGIC **Tier 2**: Azure OpenAI `text-embedding-3-small` (1536-dim) — wired via
# MAGIC `AOAI_ENDPOINT` / `AOAI_KEY` / `AOAI_EMBED_DEPLOYMENT` env vars.
# MAGIC Production should pull these from a Key Vault-backed linked service.
# MAGIC
# MAGIC **Tier 3**: Deterministic hashing fallback (384-dim) — guarantees the
# MAGIC notebook is always runnable for demos and unit tests.

# COMMAND ----------

class EmbeddingClient:
    """Multi-tier embedding client with graceful fallback."""

    def __init__(self, dim: int = EMBED_DIM_FALLBACK) -> None:
        self.dim = dim
        self.model = None
        self.mode = "mock"

        if _ST_AVAILABLE:
            try:
                self.model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
                self.dim = int(self.model.get_sentence_embedding_dimension())
                self.mode = "sentence-transformers"
                print(f"Embeddings: sentence-transformers ({self.dim} dims)")
                return
            except Exception as ex:  # pragma: no cover
                print(f"Falling back from sentence-transformers: {ex}")

        if all(os.environ.get(k) for k in ("AOAI_ENDPOINT", "AOAI_KEY", "AOAI_EMBED_DEPLOYMENT")):
            # Real AOAI integration would go here.  Sketch:
            #   from openai import AzureOpenAI
            #   client = AzureOpenAI(api_key=os.environ["AOAI_KEY"], ...)
            #   resp = client.embeddings.create(model=..., input=texts)
            # For this notebook we annotate the path but keep mock to avoid
            # accidental external calls when env vars are partially set.
            print("Embeddings: AOAI env vars detected (wire up in production)")
            self.mode = "aoai-stub"

        print(f"Embeddings: deterministic mock ({self.dim} dims)")

    def _hash_embed(self, text: str) -> np.ndarray:
        """Deterministic pseudo-embedding via hashed bag-of-words."""
        vec = np.zeros(self.dim, dtype=np.float32)
        for token in re.findall(r"[A-Za-z][A-Za-z0-9]+", text.lower()):
            h = int(hashlib.md5(token.encode("utf-8")).hexdigest(), 16)
            idx = h % self.dim
            sign = 1.0 if (h >> 7) & 1 else -1.0
            vec[idx] += sign
        norm = np.linalg.norm(vec)
        return vec / norm if norm > 0 else vec

    def embed(self, texts: List[str]) -> np.ndarray:
        if self.mode == "sentence-transformers" and self.model is not None:
            arr = self.model.encode(texts, batch_size=32, normalize_embeddings=True)
            return np.asarray(arr, dtype=np.float32)
        return np.vstack([self._hash_embed(t) for t in texts]).astype(np.float32)


embedder = EmbeddingClient()
embedding_matrix = embedder.embed([c["embed_text"] for c in chunks])
print(f"Embedding matrix shape: {embedding_matrix.shape}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Persist to Delta (Eventhouse-Equivalent Schema)
# MAGIC
# MAGIC Production note — the equivalent KQL DDL on Eventhouse would be:
# MAGIC
# MAGIC ```kql
# MAGIC .create table kb_compliance_chunks (
# MAGIC     chunk_id: string, doc_id: string, title: string, source: string,
# MAGIC     section: string, chunk_index: int, content: string,
# MAGIC     bm25_text: string, token_count: int, embedding: dynamic
# MAGIC )
# MAGIC .alter column kb_compliance_chunks.embedding policy encoding type='Vector16'
# MAGIC .alter table  kb_compliance_chunks policy caching hot = 90d
# MAGIC ```
# MAGIC
# MAGIC We persist to Delta here so PySpark can run vector + BM25 search in-process.

# COMMAND ----------

records = []
for chunk, vec in zip(chunks, embedding_matrix):
    records.append(Row(
        chunk_id=chunk["chunk_id"],
        doc_id=chunk["doc_id"],
        title=chunk["title"],
        source=chunk["source"],
        section=chunk["section"],
        chunk_index=int(chunk["chunk_index"]),
        content=chunk["content"],
        bm25_text=chunk["content"].lower(),
        token_count=int(chunk["token_count"]),
        embedding=[float(x) for x in vec.tolist()],
        embed_model=embedder.mode,
        embed_dim=int(embedder.dim),
    ))

schema = StructType([
    StructField("chunk_id", StringType(), False),
    StructField("doc_id", StringType(), False),
    StructField("title", StringType(), True),
    StructField("source", StringType(), True),
    StructField("section", StringType(), True),
    StructField("chunk_index", IntegerType(), True),
    StructField("content", StringType(), True),
    StructField("bm25_text", StringType(), True),
    StructField("token_count", IntegerType(), True),
    StructField("embedding", ArrayType(FloatType()), True),
    StructField("embed_model", StringType(), True),
    StructField("embed_dim", IntegerType(), True),
])

df_chunks = spark.createDataFrame(records, schema=schema) \
    .withColumn("ingested_at", current_timestamp())

try:
    df_chunks.write.format("delta").mode("overwrite") \
        .option("overwriteSchema", "true").saveAsTable(VECTOR_TABLE)
    print(f"Wrote {df_chunks.count()} rows to {VECTOR_TABLE}")
except Exception as ex:  # pragma: no cover - schema may not exist in dev
    print(f"Delta write skipped ({ex}); continuing with in-memory chunks.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Pure Vector Retrieval (Cosine Similarity)
# MAGIC
# MAGIC In Eventhouse this is `series_cosine_similarity(embedding, query_vec)`.
# MAGIC Here we compute against the in-memory matrix for clarity. For very
# MAGIC large corpora, the Delta table is read back and similarity is computed
# MAGIC via a `pandas_udf` (same pattern as `02_ml_fraud_detection.py`).

# COMMAND ----------

CHUNK_INDEX_BY_ID = {c["chunk_id"]: i for i, c in enumerate(chunks)}


def vector_search(query: str, top_k: int = 10) -> List[Dict[str, Any]]:
    q_vec = embedder.embed([query])[0]
    q_norm = np.linalg.norm(q_vec)
    if q_norm == 0:
        return []
    q_unit = q_vec / q_norm
    matrix_norms = np.linalg.norm(embedding_matrix, axis=1)
    safe_norms = np.where(matrix_norms == 0, 1.0, matrix_norms)
    sims = (embedding_matrix @ q_unit) / safe_norms
    order = np.argsort(-sims)[:top_k]
    return [
        {**chunks[i], "score_vector": float(sims[i]), "rank_vector": rank + 1}
        for rank, i in enumerate(order)
    ]


sample_q = "What triggers a Currency Transaction Report?"
vec_hits = vector_search(sample_q, top_k=5)
print(f"Top-5 vector hits for: {sample_q!r}")
for h in vec_hits:
    print(f"  {h['rank_vector']:>2}. {h['chunk_id']:<28} sim={h['score_vector']:.3f}  {h['title']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. BM25 Lexical Retrieval
# MAGIC
# MAGIC We implement a self-contained BM25 (k1=1.5, b=0.75) over the chunk
# MAGIC corpus — no sklearn dependency. In Eventhouse you would use the
# MAGIC `search` operator with relevance scoring or `countof()` keyword tallies.

# COMMAND ----------

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9]+")
_STOPWORDS = set("a an and are as at be by for from has have in is it its of on or that the to was were will with".split())


def tokenize(text: str) -> List[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text) if t.lower() not in _STOPWORDS]


class BM25Index:
    """Minimal BM25 implementation for in-memory corpora."""

    def __init__(self, docs: List[List[str]], k1: float = 1.5, b: float = 0.75) -> None:
        self.k1, self.b = k1, b
        self.docs = docs
        self.n = len(docs)
        self.lengths = np.array([len(d) for d in docs], dtype=np.float32)
        self.avgdl = float(self.lengths.mean()) if self.n else 0.0
        self.df: Dict[str, int] = defaultdict(int)
        self.tf: List[Counter] = []
        for d in docs:
            counts = Counter(d)
            self.tf.append(counts)
            for term in counts:
                self.df[term] += 1
        self.idf = {
            term: math.log(1 + (self.n - df + 0.5) / (df + 0.5))
            for term, df in self.df.items()
        }

    def score(self, query_tokens: List[str]) -> np.ndarray:
        scores = np.zeros(self.n, dtype=np.float32)
        for term in query_tokens:
            if term not in self.idf:
                continue
            idf = self.idf[term]
            for i, counts in enumerate(self.tf):
                f = counts.get(term, 0)
                if f == 0:
                    continue
                denom = f + self.k1 * (1 - self.b + self.b * self.lengths[i] / max(self.avgdl, 1e-6))
                scores[i] += idf * (f * (self.k1 + 1)) / denom
        return scores


bm25 = BM25Index([tokenize(c["bm25_text"]) for c in chunks])


def bm25_search(query: str, top_k: int = 10) -> List[Dict[str, Any]]:
    scores = bm25.score(tokenize(query))
    order = np.argsort(-scores)[:top_k]
    return [
        {**chunks[i], "score_bm25": float(scores[i]), "rank_bm25": rank + 1}
        for rank, i in enumerate(order) if scores[i] > 0
    ]


bm25_hits = bm25_search(sample_q, top_k=5)
print(f"Top-5 BM25 hits for: {sample_q!r}")
for h in bm25_hits:
    print(f"  {h['rank_bm25']:>2}. {h['chunk_id']:<28} bm25={h['score_bm25']:.3f}  {h['title']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Hybrid Fusion — Reciprocal Rank Fusion (RRF)
# MAGIC
# MAGIC Per the deep-dive doc: `RRF(d) = Σ 1 / (k + rank_i(d))`, with `k = 60`.
# MAGIC RRF combines vector + BM25 rankings without needing comparable scores.

# COMMAND ----------

def hybrid_search(query: str, top_k: int = 10, k_rrf: int = 60) -> List[Dict[str, Any]]:
    vec = vector_search(query, top_k=top_k)
    bm = bm25_search(query, top_k=top_k)

    by_id: Dict[str, Dict[str, Any]] = {}
    for h in vec:
        rec = by_id.setdefault(h["chunk_id"], {**h})
        rec["rrf_score"] = rec.get("rrf_score", 0.0) + 1.0 / (k_rrf + h["rank_vector"])
    for h in bm:
        rec = by_id.setdefault(h["chunk_id"], {**h})
        rec.setdefault("score_vector", 0.0)
        rec.setdefault("rank_vector", None)
        rec["score_bm25"] = h["score_bm25"]
        rec["rank_bm25"] = h["rank_bm25"]
        rec["rrf_score"] = rec.get("rrf_score", 0.0) + 1.0 / (k_rrf + h["rank_bm25"])

    fused = sorted(by_id.values(), key=lambda r: -r["rrf_score"])[:top_k]
    for rank, h in enumerate(fused, start=1):
        h["rank_hybrid"] = rank
    return fused


hybrid_hits = hybrid_search(sample_q, top_k=5)
print(f"Top-5 hybrid (RRF) hits for: {sample_q!r}")
for h in hybrid_hits:
    print(f"  {h['rank_hybrid']:>2}. {h['chunk_id']:<28} rrf={h['rrf_score']:.4f}  {h['title']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 8. Reranking — Cross-Encoder (or LLM-as-Judge stub)
# MAGIC
# MAGIC The cross-encoder sees `(query, candidate)` jointly and is far more
# MAGIC accurate than bi-encoder retrieval. Production default in the
# MAGIC deep-dive doc: `BAAI/bge-reranker-v2-m3` or
# MAGIC `cross-encoder/ms-marco-MiniLM-L-6-v2` for a smaller footprint.
# MAGIC
# MAGIC When unavailable we use a deterministic lexical-overlap surrogate so
# MAGIC the pipeline stays runnable.

# COMMAND ----------

class Reranker:
    def __init__(self) -> None:
        self.model = None
        self.mode = "lexical-overlap"
        if _ST_AVAILABLE:
            try:
                self.model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2", max_length=512)
                self.mode = "cross-encoder"
            except Exception as ex:  # pragma: no cover
                print(f"Cross-encoder unavailable, falling back: {ex}")
        print(f"Reranker mode: {self.mode}")

    def _lexical(self, query: str, candidate: str) -> float:
        q = set(tokenize(query))
        c = set(tokenize(candidate))
        if not q or not c:
            return 0.0
        return len(q & c) / len(q | c)  # Jaccard surrogate

    def rerank(self, query: str, candidates: List[Dict[str, Any]], top_k: int = 3) -> List[Dict[str, Any]]:
        if not candidates:
            return []
        if self.model is not None:
            pairs = [(query, c["content"]) for c in candidates]
            scores = self.model.predict(pairs, batch_size=16)
        else:
            scores = [self._lexical(query, c["content"]) for c in candidates]
        for cand, score in zip(candidates, scores):
            cand["rerank_score"] = float(score)
        ranked = sorted(candidates, key=lambda x: -x["rerank_score"])[:top_k]
        for rank, cand in enumerate(ranked, start=1):
            cand["rank_rerank"] = rank
        return ranked


reranker = Reranker()
final_top = reranker.rerank(sample_q, hybrid_hits, top_k=3)
print(f"Top-3 reranked for: {sample_q!r}")
for h in final_top:
    print(f"  {h['rank_rerank']:>2}. {h['chunk_id']:<28} rerank={h['rerank_score']:.4f}  {h['title']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 9. Generation — Stuffed Prompt with Citation Markers
# MAGIC
# MAGIC We build the canonical "stuff" prompt from the deep-dive doc. The actual
# MAGIC LLM call is a stub — wire to AOAI / Anthropic via the workspace secret
# MAGIC scope. **Never** hard-code keys.

# COMMAND ----------

STUFF_TEMPLATE = (
    "You are a casino BSA/AML compliance assistant. Answer the question using "
    "ONLY the passages below. Cite each claim with the passage id like [P3]. "
    "If the passages do not contain the answer, say \"I don't have that "
    "information in the provided sources.\"\n\n"
    "Passages:\n{passages}\n\n"
    "Question: {question}\n\n"
    "Answer (with citations):"
)


def build_prompt(query: str, ctx: List[Dict[str, Any]]) -> str:
    formatted = "\n\n".join(
        f"[P{i+1}] (source: {c['title']} > {c['section']} | {c['source']})\n{c['content']}"
        for i, c in enumerate(ctx)
    )
    return STUFF_TEMPLATE.format(passages=formatted, question=query)


def generate_answer(query: str, ctx: List[Dict[str, Any]]) -> Dict[str, Any]:
    """LLM call placeholder — returns a deterministic templated answer.

    Production: replace this body with an AOAI or Anthropic chat-completion
    call, passing `prompt` as the user message. Keep the same return contract
    so the downstream eval harness is unaffected.
    """
    prompt = build_prompt(query, ctx)
    citations = " ".join(f"[P{i+1}]" for i in range(len(ctx)))
    answer = (
        f"Based on the retrieved compliance passages: "
        f"{ctx[0]['content'][:220]}... {citations}"
    ) if ctx else "I don't have that information in the provided sources."
    return {
        "answer": answer,
        "prompt": prompt,
        "model": "stub-llm",
        "context_chunks": [c["chunk_id"] for c in ctx],
    }


answer = generate_answer(sample_q, final_top)
print("--- Generated answer ---")
print(answer["answer"][:400])
print(f"\nContext chunks used: {answer['context_chunks']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 10. Citation Tracking
# MAGIC
# MAGIC Extract `[P#]` markers from the answer and resolve them back to source
# MAGIC chunks. For regulated domains this list should be rendered as
# MAGIC clickable links to the source document.

# COMMAND ----------

CITATION_RE = re.compile(r"\[P(\d+)\]")


def extract_citations(answer_text: str, ctx: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cited_idxs = sorted({int(m.group(1)) - 1 for m in CITATION_RE.finditer(answer_text)})
    return [
        {
            "marker": f"P{i+1}",
            "chunk_id": ctx[i]["chunk_id"],
            "doc_id": ctx[i]["doc_id"],
            "title": ctx[i]["title"],
            "section": ctx[i]["section"],
            "source": ctx[i]["source"],
        }
        for i in cited_idxs if 0 <= i < len(ctx)
    ]


citations = extract_citations(answer["answer"], final_top)
print(f"Resolved {len(citations)} citations:")
for c in citations:
    print(f"  {c['marker']} -> {c['chunk_id']}  ({c['source']})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 11. Evaluation Harness
# MAGIC
# MAGIC A small **golden** test set with the chunk that should appear for each
# MAGIC question. We compute:
# MAGIC
# MAGIC - **Recall@5** — did the relevant chunk appear in the top-5?
# MAGIC - **MRR** — mean reciprocal rank of the first relevant chunk
# MAGIC - **Faithfulness (stub)** — would be LLM-as-judge in production
# MAGIC - **Answer Relevance (stub)** — would compare query / answer embeddings

# COMMAND ----------

GOLDEN_SET: List[Dict[str, Any]] = [
    {"q": "What is the CTR threshold for casinos?", "relevant": ["BSA-CTR-001"]},
    {"q": "How are cash transactions aggregated for CTR?", "relevant": ["BSA-CTR-002"]},
    {"q": "When must a SAR be filed?", "relevant": ["BSA-SAR-001", "BSA-SAR-003"]},
    {"q": "What is structuring?", "relevant": ["BSA-SAR-002"]},
    {"q": "How long do casinos have to file a SAR after detection?", "relevant": ["BSA-SAR-003"]},
    {"q": "What is the slot machine W-2G threshold?", "relevant": ["W2G-001"]},
    {"q": "When does backup withholding apply to gambling winnings?", "relevant": ["W2G-002"]},
    {"q": "What MICS controls apply to the cage?", "relevant": ["MICS-CAGE-001"]},
    {"q": "What are the five pillars of a BSA compliance program?", "relevant": ["BSA-PROG-001"]},
    {"q": "What is the OFAC screening requirement for casino patrons?", "relevant": ["AML-OFAC-001"]},
]


def evaluate_query(q: Dict[str, Any], k: int = 5) -> Dict[str, Any]:
    hits = hybrid_search(q["q"], top_k=k)
    relevant_set = set(q["relevant"])
    hit_doc_ids = [h["doc_id"] for h in hits]

    found = [i for i, d in enumerate(hit_doc_ids, start=1) if d in relevant_set]
    recall_at_k = 1.0 if found else 0.0
    mrr = 1.0 / found[0] if found else 0.0

    reranked = reranker.rerank(q["q"], hits, top_k=3)
    answer = generate_answer(q["q"], reranked)
    citations_found = extract_citations(answer["answer"], reranked)

    # Faithfulness stub — fraction of cited chunks whose doc_id is in relevant set
    faithful_hits = sum(1 for c in citations_found if c["doc_id"] in relevant_set)
    faithfulness = faithful_hits / max(1, len(citations_found))

    # Answer relevance stub — cosine between query and answer embeddings
    embeds = embedder.embed([q["q"], answer["answer"]])
    denom = (np.linalg.norm(embeds[0]) * np.linalg.norm(embeds[1])) or 1.0
    answer_relevance = float(np.dot(embeds[0], embeds[1]) / denom)

    return {
        "query": q["q"],
        "relevant_doc_ids": list(relevant_set),
        "top_doc_ids": hit_doc_ids,
        "recall_at_5": recall_at_k,
        "mrr": mrr,
        "faithfulness_stub": faithfulness,
        "answer_relevance_stub": answer_relevance,
        "answer": answer["answer"][:300],
    }


eval_rows = [evaluate_query(q) for q in GOLDEN_SET]
eval_df = pd.DataFrame(eval_rows)
print("Per-query metrics:")
print(eval_df[["query", "recall_at_5", "mrr", "faithfulness_stub", "answer_relevance_stub"]].to_string(index=False))

agg = {
    "n_queries": len(eval_rows),
    "recall_at_5_mean": float(eval_df["recall_at_5"].mean()),
    "mrr_mean": float(eval_df["mrr"].mean()),
    "faithfulness_mean": float(eval_df["faithfulness_stub"].mean()),
    "answer_relevance_mean": float(eval_df["answer_relevance_stub"].mean()),
}
print("\nAggregate metrics:")
for k, v in agg.items():
    print(f"  {k:<24} {v}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 12. Persist Eval Results to `lh_gold.rag_eval_results`
# MAGIC
# MAGIC Append-only Delta table for trend tracking — every notebook run writes
# MAGIC a fresh row per golden query plus an aggregate row tagged
# MAGIC `query='__AGGREGATE__'`.

# COMMAND ----------

run_id = str(uuid.uuid4())
run_started_at = datetime.utcnow()

eval_records = []
for r in eval_rows:
    eval_records.append(Row(
        run_id=run_id,
        run_started_at=run_started_at,
        query=r["query"],
        relevant_doc_ids=r["relevant_doc_ids"],
        top_doc_ids=r["top_doc_ids"],
        recall_at_5=float(r["recall_at_5"]),
        mrr=float(r["mrr"]),
        faithfulness_stub=float(r["faithfulness_stub"]),
        answer_relevance_stub=float(r["answer_relevance_stub"]),
        answer_preview=r["answer"],
        embed_model=embedder.mode,
        rerank_mode=reranker.mode,
    ))
eval_records.append(Row(
    run_id=run_id,
    run_started_at=run_started_at,
    query="__AGGREGATE__",
    relevant_doc_ids=[],
    top_doc_ids=[],
    recall_at_5=agg["recall_at_5_mean"],
    mrr=agg["mrr_mean"],
    faithfulness_stub=agg["faithfulness_mean"],
    answer_relevance_stub=agg["answer_relevance_mean"],
    answer_preview=f"agg over {agg['n_queries']} queries",
    embed_model=embedder.mode,
    rerank_mode=reranker.mode,
))

eval_schema = StructType([
    StructField("run_id", StringType(), False),
    StructField("run_started_at", TimestampType(), False),
    StructField("query", StringType(), False),
    StructField("relevant_doc_ids", ArrayType(StringType()), True),
    StructField("top_doc_ids", ArrayType(StringType()), True),
    StructField("recall_at_5", DoubleType(), True),
    StructField("mrr", DoubleType(), True),
    StructField("faithfulness_stub", DoubleType(), True),
    StructField("answer_relevance_stub", DoubleType(), True),
    StructField("answer_preview", StringType(), True),
    StructField("embed_model", StringType(), True),
    StructField("rerank_mode", StringType(), True),
])

df_eval = spark.createDataFrame(eval_records, schema=eval_schema)

try:
    df_eval.write.format("delta").mode("append").saveAsTable(EVAL_TABLE)
    print(f"Appended {df_eval.count()} eval rows to {EVAL_TABLE} (run_id={run_id})")
except Exception as ex:  # pragma: no cover
    print(f"Eval table write skipped ({ex}); aggregate metrics still printed above.")

# Optional MLflow logging
if _MLFLOW_AVAILABLE:
    try:
        mlflow.set_experiment("/Shared/rag_eventhouse_vector")
        with mlflow.start_run(run_name=f"rag_eval_{run_id[:8]}"):
            mlflow.log_param("embed_model", embedder.mode)
            mlflow.log_param("rerank_mode", reranker.mode)
            mlflow.log_param("n_chunks", len(chunks))
            mlflow.log_param("chunk_size_tokens", 512)
            mlflow.log_param("chunk_overlap_tokens", 64)
            for k, v in agg.items():
                mlflow.log_metric(k, v)
        print("Logged run to MLflow.")
    except Exception as ex:  # pragma: no cover
        print(f"MLflow logging skipped: {ex}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 13. Production Patterns — Cache, Latency, Cost
# MAGIC
# MAGIC Production RAG endpoints need:
# MAGIC
# MAGIC - **Query cache** — most QA traffic is long-tail repeats (helpdesk,
# MAGIC   policy lookups). LRU keyed by `hash(query + tenant_id + filters)`.
# MAGIC - **Latency tracking** — P50/P95/P99 buckets per stage (retrieve,
# MAGIC   rerank, generate). Surface in Workspace Monitoring.
# MAGIC - **Cost tracking** — embedding tokens, rerank tokens, generation
# MAGIC   tokens, all attributed to `tenant_id` for chargeback.

# COMMAND ----------

class QueryCache:
    """Tiny LRU-ish cache for demonstration; production should use Redis or
    Eventhouse materialized views for shared cache across replicas."""

    def __init__(self, max_size: int = 256) -> None:
        self.max_size = max_size
        self.store: Dict[str, Dict[str, Any]] = {}

    @staticmethod
    def _key(query: str, tenant_id: str = "casino-prod") -> str:
        return hashlib.sha256(f"{tenant_id}::{query}".encode("utf-8")).hexdigest()

    def get(self, query: str, tenant_id: str = "casino-prod") -> Optional[Dict[str, Any]]:
        return self.store.get(self._key(query, tenant_id))

    def put(self, query: str, payload: Dict[str, Any], tenant_id: str = "casino-prod") -> None:
        if len(self.store) >= self.max_size:
            self.store.pop(next(iter(self.store)))
        self.store[self._key(query, tenant_id)] = payload


cache = QueryCache()


def rag_pipeline(query: str, top_k: int = 3, tenant_id: str = "casino-prod") -> Dict[str, Any]:
    cached = cache.get(query, tenant_id=tenant_id)
    if cached:
        return {**cached, "cache_hit": True}

    timings: Dict[str, float] = {}
    t0 = time.perf_counter()
    fused = hybrid_search(query, top_k=top_k * 4)
    timings["retrieve_ms"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    final_ctx = reranker.rerank(query, fused, top_k=top_k)
    timings["rerank_ms"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    gen = generate_answer(query, final_ctx)
    timings["generate_ms"] = (time.perf_counter() - t0) * 1000

    cites = extract_citations(gen["answer"], final_ctx)

    # Cost stub — replace with provider-specific token counts.
    approx_tokens = sum(c["token_count"] for c in final_ctx) + _approx_token_count(gen["answer"])
    cost_stub_usd = approx_tokens * 0.000_002  # placeholder $/token

    payload = {
        "query": query,
        "answer": gen["answer"],
        "context_chunks": [c["chunk_id"] for c in final_ctx],
        "citations": cites,
        "timings_ms": timings,
        "approx_tokens": approx_tokens,
        "cost_stub_usd": cost_stub_usd,
        "cache_hit": False,
    }
    cache.put(query, payload, tenant_id=tenant_id)
    return payload


# Smoke-test the end-to-end pipeline
demo_qs = [
    "What is the CTR threshold for casinos?",
    "What is structuring?",
    "What is the CTR threshold for casinos?",  # cache hit on second call
]
for dq in demo_qs:
    out = rag_pipeline(dq, top_k=3)
    print(f"\nQ: {dq}")
    print(f"  cache_hit={out['cache_hit']}  tokens~{out['approx_tokens']}  "
          f"cost~${out['cost_stub_usd']:.6f}  timings={out['timings_ms']}")
    print(f"  answer: {out['answer'][:160]}...")
    print(f"  citations: {[c['marker'] for c in out['citations']]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 14. Cleanup
# MAGIC
# MAGIC The `lh_silver.kb_compliance_chunks` Delta table and any MLflow runs
# MAGIC are intentionally kept for downstream agents. Drop manually if needed:
# MAGIC
# MAGIC ```sql
# MAGIC DROP TABLE IF EXISTS lh_silver.kb_compliance_chunks;
# MAGIC DROP TABLE IF EXISTS lh_gold.rag_eval_results;
# MAGIC ```

# COMMAND ----------

# MAGIC %md
# MAGIC ## Production Deployment Notes
# MAGIC
# MAGIC 1. **Move embeddings to Eventhouse** — write the chunks table to a KQL
# MAGIC    DB with `Vector16` encoding; replace `vector_search()` with KQL
# MAGIC    `series_cosine_similarity()`.
# MAGIC 2. **Real LLM** — replace `generate_answer()` body with AOAI / Anthropic
# MAGIC    SDK calls; pull keys from a Key Vault-backed linked service.
# MAGIC 3. **Sensitivity labels** — add `tenant_id` and `sensitivity_label`
# MAGIC    columns and filter at retrieval.
# MAGIC 4. **Re-embed cadence** — schedule weekly/monthly re-embed of changed
# MAGIC    documents; track `embed_model` per chunk for safe migration.
# MAGIC 5. **Eval gate** — fail CI if `recall@5 < 0.85` or `mrr < 0.7`.
# MAGIC 6. **Observability** — emit `timings_ms` to Workspace Monitoring; alert
# MAGIC    on P95 retrieve > 200ms or P95 generate > 5s.
# MAGIC 7. **Data Agents** — expose this RAG pipeline as a tool callable by a
# MAGIC    Fabric Data Agent (see `docs/features/data-agents.md`).
