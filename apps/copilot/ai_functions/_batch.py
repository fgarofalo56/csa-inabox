"""Batched AOAI execution for a ``pandas.Series`` of text.

Each non-empty row becomes one chat call; calls run on a bounded thread pool
(AOAI round-trips are I/O-bound, so threads give real parallelism despite the
GIL). Results are written back in the original order and the input index is
preserved, so the returned Series drops straight into ``df[col] = ...``.

Empty / non-string rows short-circuit to ``""`` without an AOAI call. Any AOAI
failure propagates as a typed :class:`AoaiBridgeError` — the batch fails loud
rather than silently returning blanks (the no-vaporware contract).

Concurrency is tunable via ``LOOM_AI_FN_WORKERS`` (default 8).
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any

from ._client import call_chat
from ._prompts import build_system_prompt

if TYPE_CHECKING:
    import pandas as pd

_DEFAULT_WORKERS = 8


def _worker_count() -> int:
    raw = os.environ.get("LOOM_AI_FN_WORKERS")
    if raw and raw.isdigit() and int(raw) > 0:
        return int(raw)
    return _DEFAULT_WORKERS


def batch_call(series: pd.Series, fn_name: str, options: dict[str, Any]) -> pd.Series:
    """Run ``fn_name`` over every row of ``series`` and return an aligned Series."""
    import pandas as pd

    system_prompt = build_system_prompt(
        fn_name,
        labels=options.get("labels"),
        fields=options.get("fields"),
        target_lang=options.get("target_lang"),
    )
    max_tokens = int(options.get("max_tokens", 800))

    values = series.tolist()
    results: list[str] = [""] * len(values)

    def _call(index: int) -> tuple[int, str]:
        text = values[index]
        if not isinstance(text, str) or not text.strip():
            return index, ""
        return index, call_chat(system_prompt, text, max_tokens=max_tokens)

    if values:
        with ThreadPoolExecutor(max_workers=_worker_count()) as pool:
            for index, result in pool.map(_call, range(len(values))):
                results[index] = result

    return pd.Series(results, index=series.index)
