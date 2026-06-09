"""System prompts + polymorphic dispatch for the five AI functions.

Public entry points — ``summarize``, ``classify``, ``sentiment``, ``extract``,
``translate`` — each accept a single ``data`` argument that may be:

* a ``str``                 → one AOAI call, returns a ``str``;
* a ``pandas.Series``       → batched AOAI calls, returns a ``pandas.Series``
  aligned to the input index (use this in a pandas notebook cell);
* a ``pyspark.sql.Column``  → a vectorized ``pandas_udf`` that batches AOAI
  calls on each executor, returns a ``Column`` (use this with
  ``df.withColumn(...)`` in a Spark cell).

The system prompts are copied verbatim from ``ai-functions-client.ts`` so the
notebook surface and the Console SQL-editor surface produce identical output.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ._batch import batch_call
from ._client import call_chat
from ._prompts import build_system_prompt

if TYPE_CHECKING:
    import pandas as pd


def _is_series(value: Any) -> bool:
    try:
        import pandas as pd
    except ImportError:
        return False
    return isinstance(value, pd.Series)


def _pyspark_dispatch(fn: str, column: Any, options: dict[str, Any]) -> Any:
    """Wrap ``batch_call`` in a vectorized pandas_udf and apply it to ``column``."""
    try:
        from pyspark.sql.functions import pandas_udf
    except ImportError as exc:
        raise TypeError(
            "A pyspark Column was passed but PySpark is not importable. Pass a pandas.Series "
            "or a str instead, or run this cell on a Spark pool."
        ) from exc

    @pandas_udf("string")
    def _udf(series: pd.Series) -> pd.Series:
        return batch_call(series, fn, options)

    return _udf(column)


def _prompt_options(options: dict[str, Any]) -> dict[str, Any]:
    """The subset of options that shape the system prompt (drops max_tokens)."""
    return {k: options[k] for k in ("labels", "fields", "target_lang") if k in options}


def _dispatch(fn: str, data: Any, options: dict[str, Any]) -> Any:
    if isinstance(data, str):
        prompt = build_system_prompt(fn, **_prompt_options(options))
        return call_chat(prompt, data, max_tokens=int(options.get("max_tokens", 800)))
    if _is_series(data):
        return batch_call(data, fn, options)
    # Anything else is assumed to be a pyspark Column.
    return _pyspark_dispatch(fn, data, options)


def summarize(data: Any, *, max_tokens: int = 300) -> Any:
    """Summarize each row of ``data`` in 2-3 sentences."""
    return _dispatch("summarize", data, {"max_tokens": max_tokens})


def classify(data: Any, *, labels: list[str] | None = None, max_tokens: int = 50) -> Any:
    """Classify each row of ``data`` into exactly one of ``labels``."""
    return _dispatch("classify", data, {"labels": labels, "max_tokens": max_tokens})


def sentiment(data: Any, *, max_tokens: int = 20) -> Any:
    """Label each row of ``data`` as positive / negative / neutral."""
    return _dispatch("sentiment", data, {"max_tokens": max_tokens})


def extract(data: Any, *, fields: list[str] | None = None, max_tokens: int = 400) -> Any:
    """Extract ``fields`` from each row of ``data`` as a JSON string."""
    return _dispatch("extract", data, {"fields": fields, "max_tokens": max_tokens})


def translate(data: Any, *, target_lang: str = "English", max_tokens: int = 800) -> Any:
    """Translate each row of ``data`` into ``target_lang``."""
    return _dispatch("translate", data, {"target_lang": target_lang, "max_tokens": max_tokens})
