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
from ._embed import call_embed, cosine
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


def fix_grammar(data: Any, *, max_tokens: int = 800) -> Any:
    """Correct spelling / grammar / punctuation of each row of ``data``."""
    return _dispatch("fix_grammar", data, {"max_tokens": max_tokens})


def generate_response(data: Any, *, max_tokens: int = 800) -> Any:
    """Draft a professional response to each row of ``data``."""
    return _dispatch("generate_response", data, {"max_tokens": max_tokens})


def embed(data: Any) -> Any:
    """Return the Azure OpenAI embedding vector for ``data``.

    * ``str``            → a ``list[float]`` vector;
    * ``pandas.Series``  → a Series of ``list[float]`` aligned to the input index.

    (A pyspark ``Column`` is not supported for ``embed`` — collect to pandas or
    pass a Series; a vector-per-row column is rarely what a Spark cell wants.)
    """
    if isinstance(data, str):
        vectors = call_embed([data])
        return vectors[0] if vectors else []
    if _is_series(data):
        import pandas as pd

        values = [v if isinstance(v, str) and v.strip() else "" for v in data.tolist()]
        non_empty = [(i, v) for i, v in enumerate(values) if v]
        results: list[list[float]] = [[] for _ in values]
        if non_empty:
            vectors = call_embed([v for _, v in non_empty])
            for (idx, _), vec in zip(non_empty, vectors):
                results[idx] = vec
        return pd.Series(results, index=data.index)
    raise TypeError(
        "embed() accepts a str or a pandas.Series. For a Spark DataFrame, collect the "
        "column to pandas (df.select(col).toPandas()[col]) before calling embed()."
    )


def similarity(data: Any, compare_to: str) -> Any:
    """Cosine similarity of each row of ``data`` against ``compare_to``.

    * ``str``            → a ``float`` in [-1, 1];
    * ``pandas.Series``  → a Series of floats aligned to the input index.
    """
    if not isinstance(compare_to, str) or not compare_to.strip():
        raise ValueError("similarity() requires a non-empty compare_to string.")
    reference = call_embed([compare_to])[0]

    if isinstance(data, str):
        vec = call_embed([data])[0]
        return cosine(vec, reference)
    if _is_series(data):
        import pandas as pd

        values = [v if isinstance(v, str) and v.strip() else "" for v in data.tolist()]
        non_empty = [(i, v) for i, v in enumerate(values) if v]
        scores: list[float] = [0.0] * len(values)
        if non_empty:
            vectors = call_embed([v for _, v in non_empty])
            for (idx, _), vec in zip(non_empty, vectors):
                scores[idx] = cosine(vec, reference)
        return pd.Series(scores, index=data.index)
    raise TypeError(
        "similarity() accepts a str or a pandas.Series. For a Spark DataFrame, collect the "
        "column to pandas before calling similarity()."
    )
