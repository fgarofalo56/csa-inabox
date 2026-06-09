"""Loom AI functions — LLM enrichment for Spark/pandas notebook cells.

A tiny helper library, bundled into the Loom Spark environment, that lets an
analyst enrich a text column from inside a notebook cell with Azure OpenAI —
no Microsoft Fabric, no Power BI, no OneLake dependency::

    import ai_functions as ai

    ai.check_reachable()                       # honest gate (first cell)
    df["label"] = ai.classify(df["text"],      # pandas Series -> Series
                              labels=["urgent", "normal", "low"])
    sdf = sdf.withColumn("summary",            # pyspark Column -> Column
                         ai.summarize(col("description")))

Five functions mirror the Console SQL-editor AI Functions surface and Fabric's
AI functions DataFrame APIs: ``summarize``, ``classify``, ``sentiment``,
``extract``, ``translate``. Configuration is read from the Spark pool
environment (``LOOM_AOAI_ENDPOINT`` / ``LOOM_AOAI_DEPLOYMENT`` /
``LOOM_AOAI_AUDIENCE``) or per-session Spark conf; auth uses the pool's managed
identity (or ``LOOM_AOAI_KEY``). See ``README.md`` and the demo notebook at
``docs/fiab/notebooks/ai_functions_demo.py``.
"""

from __future__ import annotations

from ._errors import (
    AoaiBridgeAuthError,
    AoaiBridgeConfigError,
    AoaiBridgeDeploymentError,
    AoaiBridgeError,
    AoaiBridgeRateLimitError,
)
from ._gate import check_reachable
from .functions import classify, extract, sentiment, summarize, translate

__version__ = "0.1.0"

__all__ = [
    "AoaiBridgeAuthError",
    "AoaiBridgeConfigError",
    "AoaiBridgeDeploymentError",
    "AoaiBridgeError",
    "AoaiBridgeRateLimitError",
    "check_reachable",
    "classify",
    "extract",
    "sentiment",
    "summarize",
    "translate",
]
