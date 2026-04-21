"""Azure ML online-endpoint inference handler for the loan-default model.

Follows the Azure ML v2 online-endpoint contract:

  * :func:`init` is called once per container start.  It loads the
    pickled pipeline from ``AZUREML_MODEL_DIR`` and caches it in a
    module-level global.
  * :func:`run` is invoked per request with the raw JSON body.

The handler also works standalone — import and call :func:`score_records`
from a notebook or local test without going through the Azure ML runtime.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, cast

# Loaded lazily inside init() / the standalone path.
_MODEL: Any = None


def _find_model_path() -> Path:
    """Locate the pickled model file.

    Azure ML exposes ``AZUREML_MODEL_DIR`` pointing to the model folder.
    Locally we fall back to ``./outputs/model.pkl`` next to :mod:`train`.
    """
    aml_dir = os.environ.get("AZUREML_MODEL_DIR", "")
    if aml_dir:
        # Models registered via CLI produce layouts like
        #   $AZUREML_MODEL_DIR/INPUT_model/model.pkl  OR
        #   $AZUREML_MODEL_DIR/model.pkl
        candidate = Path(aml_dir)
        direct = candidate / "model.pkl"
        if direct.exists():
            return direct
        # Walk one level for the typical nested layout.
        for child in candidate.iterdir():
            nested = child / "model.pkl"
            if nested.exists():
                return nested
    return (Path(__file__).resolve().parent / "outputs" / "model.pkl").resolve()


def init() -> None:
    """Load the model into memory (called once by the Azure ML runtime)."""
    global _MODEL
    import joblib

    path = _find_model_path()
    _MODEL = joblib.load(path)


def _ensure_model() -> Any:
    """Return the loaded model, lazy-loading on first call if needed."""
    global _MODEL
    if _MODEL is None:
        init()
    return _MODEL


def score_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Score a list of feature dicts.

    Each input dict must contain the feature fields defined in
    ``contracts/loan_training_features.yaml``; extra keys are ignored
    and missing keys raise :class:`KeyError`.

    Returns:
        A list of ``{"probability_default": float, "prediction": int}``
        dicts aligned with the input records.
    """
    model = _ensure_model()

    # DataFrame path (preferred — sklearn's ColumnTransformer expects one).
    try:
        import pandas as pd

        x = pd.DataFrame(records)
    except ImportError:  # pragma: no cover - pandas ships with sklearn
        x = records

    probs = model.predict_proba(x)[:, 1]
    preds = (probs >= 0.5).astype(int)

    return [
        {
            "probability_default": float(p),
            "prediction": int(pred),
        }
        for p, pred in zip(probs, preds)
    ]


def run(raw_data: str | bytes | dict[str, Any]) -> str:
    """Azure ML entry point — handles a single request body.

    Accepts either a JSON string / bytes or an already-parsed dict with
    a ``data`` key containing the list of feature rows::

        {"data": [{"credit_score": 720, ...}, ...]}

    Returns a JSON string with the scores.
    """
    if isinstance(raw_data, (str, bytes, bytearray)):
        body = json.loads(raw_data)
    else:
        body = raw_data

    records = cast(list[dict[str, Any]], body.get("data", []))
    scores = score_records(records)
    return json.dumps({"predictions": scores})


__all__ = [
    "init",
    "run",
    "score_records",
]
