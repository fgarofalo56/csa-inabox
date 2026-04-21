"""End-to-end tests for the ``score.run`` inference handler.

Trains a model to a tmp dir, points the ``AZUREML_MODEL_DIR`` env var
at that dir, and verifies:

  * :func:`score.run` returns valid JSON with per-row predictions.
  * Probabilities are in [0, 1] and predictions are in {0, 1}.
  * :func:`score.score_records` produces the same output as :func:`run`
    when given the same inputs.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

_TRAIN_DIR = Path(__file__).resolve().parent.parent
if str(_TRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(_TRAIN_DIR))


@pytest.fixture(scope="module")
def trained_model_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Train a model into a tmp directory shaped like AZUREML_MODEL_DIR."""
    from train import run_training

    out = tmp_path_factory.mktemp("aml_model_dir")
    run_training(rows=1500, seed=42, output_dir=out)
    return out


@pytest.fixture
def _score_module(trained_model_dir: Path, monkeypatch: pytest.MonkeyPatch) -> object:
    """Import score.py fresh, with AZUREML_MODEL_DIR pointed at the model."""
    monkeypatch.setenv("AZUREML_MODEL_DIR", str(trained_model_dir))
    # Fresh import so the module-level _MODEL is reloaded.
    for name in list(sys.modules):
        if name == "score":
            del sys.modules[name]
    import score  # type: ignore[import-not-found]

    score.init()
    return score


def _sample_payload() -> dict[str, list[dict[str, object]]]:
    return {
        "data": [
            {
                "applicant_age": 35,
                "annual_income": 72_500.0,
                "loan_amount": 18_000.0,
                "loan_term_months": 36,
                "credit_score": 710,
                "employment_years": 8.5,
                "debt_to_income": 0.22,
                "delinquencies_2yr": 0,
                "home_ownership": "MORTGAGE",
                "loan_purpose": "AUTO",
            },
            {
                "applicant_age": 22,
                "annual_income": 28_000.0,
                "loan_amount": 22_000.0,
                "loan_term_months": 60,
                "credit_score": 540,
                "employment_years": 1.0,
                "debt_to_income": 0.85,
                "delinquencies_2yr": 4,
                "home_ownership": "RENT",
                "loan_purpose": "DEBT_CONSOLIDATION",
            },
        ],
    }


def test_run_returns_valid_predictions(_score_module: object) -> None:
    payload = _sample_payload()
    raw = json.dumps(payload)
    result_json = _score_module.run(raw)  # type: ignore[attr-defined]
    result = json.loads(result_json)

    preds = result["predictions"]
    assert len(preds) == 2
    for pred in preds:
        assert 0.0 <= pred["probability_default"] <= 1.0
        assert pred["prediction"] in (0, 1)


def test_run_matches_score_records(_score_module: object) -> None:
    payload = _sample_payload()
    via_run = json.loads(_score_module.run(json.dumps(payload)))["predictions"]  # type: ignore[attr-defined]
    via_records = _score_module.score_records(payload["data"])  # type: ignore[attr-defined]
    assert len(via_run) == len(via_records)
    for a, b in zip(via_run, via_records):
        assert a["prediction"] == b["prediction"]
        assert abs(a["probability_default"] - b["probability_default"]) < 1e-9


def test_higher_risk_applicant_gets_higher_probability(_score_module: object) -> None:
    """Low-credit, high-DTI, unemployed applicant should score riskier."""
    records = [
        # Low risk
        {
            "applicant_age": 45,
            "annual_income": 140_000.0,
            "loan_amount": 10_000.0,
            "loan_term_months": 24,
            "credit_score": 820,
            "employment_years": 18.0,
            "debt_to_income": 0.10,
            "delinquencies_2yr": 0,
            "home_ownership": "OWN",
            "loan_purpose": "HOME_IMPROVEMENT",
        },
        # High risk
        {
            "applicant_age": 21,
            "annual_income": 20_000.0,
            "loan_amount": 45_000.0,
            "loan_term_months": 60,
            "credit_score": 480,
            "employment_years": 0.5,
            "debt_to_income": 1.20,
            "delinquencies_2yr": 7,
            "home_ownership": "RENT",
            "loan_purpose": "BUSINESS",
        },
    ]
    scores = _score_module.score_records(records)  # type: ignore[attr-defined]
    assert (
        scores[1]["probability_default"] > scores[0]["probability_default"]
    ), f"high-risk applicant scored lower: {scores}"


def test_run_accepts_bytes(_score_module: object) -> None:
    payload = _sample_payload()
    raw = json.dumps(payload).encode("utf-8")
    # Should not raise
    result = json.loads(_score_module.run(raw))  # type: ignore[attr-defined]
    assert "predictions" in result


def test_find_model_path_uses_azureml_model_dir(
    trained_model_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AZUREML_MODEL_DIR", str(trained_model_dir))
    for name in list(sys.modules):
        if name == "score":
            del sys.modules[name]
    import score  # type: ignore[import-not-found]

    found = score._find_model_path()
    assert found.exists()
    assert str(trained_model_dir) in str(found)


def test_find_model_path_falls_back_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AZUREML_MODEL_DIR", raising=False)
    for name in list(sys.modules):
        if name == "score":
            del sys.modules[name]
    import score  # type: ignore[import-not-found]

    # Either the ./outputs/model.pkl exists (if a previous `python train.py`
    # was run there) or it doesn't; but the function must not error and
    # must return a Path pointing at the expected local filename.
    path = score._find_model_path()
    assert path.name == "model.pkl"
    # Hitting the fallback branch, not AML — assertion about the env
    assert os.environ.get("AZUREML_MODEL_DIR", "") == ""
