"""Runtime contract enforcement for the ingestion pipeline.

Provides :class:`ContractEnforcer`, a reusable component that:

1. Accepts a batch of rows (list-of-dicts or pandas DataFrame).
2. Validates each row against the contract loaded from ``contract.yaml``.
3. Splits the batch into **clean** and **quarantined** rows.
4. Emits structured log events for monitoring / alerting.
5. Optionally writes quarantined rows to a configurable output
   (local JSONL file, Azure Blob, or Cosmos DB) for later remediation.

Integration patterns
====================

**Azure Function (inline call):**

.. code-block:: python

    from governance.contracts import ContractEnforcer, load_contract

    contract = load_contract("domains/sales/data-products/orders/contract.yaml")
    enforcer = ContractEnforcer(contract)

    # In the function handler:
    result = enforcer.enforce(incoming_rows)
    if result.quarantined:
        await write_to_quarantine(result.quarantined)
    downstream_process(result.clean_rows)

**dbt pre-hook (Python model):**

.. code-block:: python

    # In a dbt Python model you can call the enforcer before
    # writing to the Silver table.
    enforcer = ContractEnforcer(contract)
    result = enforcer.enforce(df.to_dict(orient="records"))

**Decorator:**

.. code-block:: python

    @enforcer.enforce_decorator
    def process_batch(rows):
        ...  # receives only clean rows
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any, TypeVar

from governance.common.logging import get_logger
from governance.contracts.contract_validator import (
    Contract,
    validate_rows_against_contract,
)

logger = get_logger(__name__)

F = TypeVar("F", bound=Callable[..., Any])


@dataclass
class QuarantineRecord:
    """A single row that failed contract validation, annotated with
    metadata for triage and remediation."""

    row_index: int
    row_data: dict[str, Any]
    violations: list[str]
    contract_name: str
    contract_version: str
    quarantined_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    batch_id: str = field(default_factory=lambda: str(uuid.uuid4()))


@dataclass
class EnforcementResult:
    """The result of running a batch through the enforcer."""

    clean_rows: list[dict[str, Any]]
    quarantined: list[QuarantineRecord]
    total_rows: int
    clean_count: int
    quarantine_count: int
    contract_name: str
    batch_id: str
    _meets_sla: bool | None = field(default=None, repr=False)

    @property
    def clean_ratio(self) -> float:
        """Fraction of rows that passed validation (0.0 - 1.0)."""
        if self.total_rows == 0:
            return 1.0
        return self.clean_count / self.total_rows

    @property
    def meets_sla(self) -> bool | None:
        """True if the clean ratio meets the contract's ``valid_row_ratio``
        SLA.  Returns None if the SLA is not defined.

        Note: This requires the contract to be available. For standalone
        result inspection, use ``clean_ratio`` directly.
        """
        # SLA checks are performed in ContractEnforcer.enforce() which has
        # access to the contract object. This property provides a read-only
        # flag that callers can inspect after enforcement.
        return self._meets_sla


class ContractEnforcer:
    """Validate batches against a :class:`Contract` and split into
    clean / quarantined sets.

    Parameters
    ----------
    contract:
        The loaded data-product contract.
    quarantine_path:
        Optional path to a directory where quarantined rows are
        written as JSONL files (one file per batch).  When ``None``,
        quarantined rows are returned in the :class:`EnforcementResult`
        but not persisted.
    fail_fast:
        When True, stop validating a row after the first violation.
        Faster but gives less diagnostic information.
    """

    def __init__(
        self,
        contract: Contract,
        *,
        quarantine_path: Path | str | None = None,
        fail_fast: bool = False,
    ) -> None:
        self.contract = contract
        self.quarantine_path = Path(quarantine_path) if quarantine_path else None
        self.fail_fast = fail_fast

    def enforce(
        self,
        rows: Iterable[Mapping[str, Any]],
    ) -> EnforcementResult:
        """Validate ``rows`` and return an :class:`EnforcementResult`.

        Clean rows are returned as-is in ``result.clean_rows``.
        Quarantined rows are annotated with their violations and,
        if ``quarantine_path`` is set, persisted to a JSONL file.
        """
        batch_id = str(uuid.uuid4())
        row_list = [dict(r) for r in rows]
        total = len(row_list)

        # Run the existing validator to get per-row violations.
        # The validator returns strings of the form "row N: <detail>".
        all_violations = validate_rows_against_contract(
            self.contract,
            row_list,
            fail_fast=self.fail_fast,
        )

        # Parse violations back to row indices.
        # Violation strings follow the format "row <idx>: <message>".
        # We parse carefully: the row index is always the token after "row "
        # and before the first ": ", and the message is everything after.
        violations_by_row: dict[int, list[str]] = {}
        for v in all_violations:
            if v.startswith("row "):
                try:
                    # Extract "row <N>: <msg>" — split only on first ": "
                    prefix, _, msg = v.partition(": ")
                    # prefix is "row <N>", extract N
                    idx = int(prefix.removeprefix("row ").strip())
                    violations_by_row.setdefault(idx, []).append(msg if msg else v)
                except (ValueError, IndexError):
                    # Malformed violation — attach to a sentinel key
                    violations_by_row.setdefault(-1, []).append(v)
            else:
                violations_by_row.setdefault(-1, []).append(v)

        clean_rows: list[dict[str, Any]] = []
        quarantined: list[QuarantineRecord] = []

        for idx, row in enumerate(row_list):
            if idx in violations_by_row:
                quarantined.append(
                    QuarantineRecord(
                        row_index=idx,
                        row_data=row,
                        violations=violations_by_row[idx],
                        contract_name=self.contract.name,
                        contract_version=self.contract.version,
                        batch_id=batch_id,
                    )
                )
            else:
                clean_rows.append(row)

        result = EnforcementResult(
            clean_rows=clean_rows,
            quarantined=quarantined,
            total_rows=total,
            clean_count=len(clean_rows),
            quarantine_count=len(quarantined),
            contract_name=self.contract.name,
            batch_id=batch_id,
        )

        # Log summary
        logger.info(
            "contract.enforcement_result",
            contract=self.contract.name,
            batch_id=batch_id,
            total_rows=total,
            clean=result.clean_count,
            quarantined=result.quarantine_count,
            clean_ratio=round(result.clean_ratio, 4),
        )

        # Check SLA
        if self.contract.sla.valid_row_ratio is not None:
            result._meets_sla = result.clean_ratio >= self.contract.sla.valid_row_ratio
            if not result._meets_sla:
                logger.warning(
                    "contract.sla_breach",
                    contract=self.contract.name,
                    batch_id=batch_id,
                    clean_ratio=round(result.clean_ratio, 4),
                    required_ratio=self.contract.sla.valid_row_ratio,
                )

        # Persist quarantined rows
        if quarantined and self.quarantine_path:
            self._write_quarantine(quarantined, batch_id)

        return result

    def _write_quarantine(
        self,
        records: list[QuarantineRecord],
        batch_id: str,
    ) -> Path:
        """Write quarantined rows to a JSONL file."""
        assert self.quarantine_path is not None
        self.quarantine_path.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        filename = f"quarantine_{self.contract.name}_{ts}_{batch_id[:8]}.jsonl"
        out_path = self.quarantine_path / filename

        with open(out_path, "w", encoding="utf-8") as f:
            for rec in records:
                f.write(json.dumps(asdict(rec), default=str) + "\n")

        logger.info(
            "contract.quarantine_written",
            path=str(out_path),
            records=len(records),
        )
        return out_path

    def enforce_decorator(self, func: F) -> F:
        """Decorator that pre-validates rows before passing clean ones
        to the wrapped function.

        The decorated function receives only clean rows.  Quarantined
        rows are logged and optionally persisted.

        Usage::

            enforcer = ContractEnforcer(contract)

            @enforcer.enforce_decorator
            def process_batch(rows: list[dict]) -> None:
                # `rows` contains only contract-valid rows
                ...
        """

        @wraps(func)
        def wrapper(rows: Iterable[Mapping[str, Any]], *args: Any, **kwargs: Any) -> Any:
            result = self.enforce(rows)
            return func(result.clean_rows, *args, **kwargs)

        return wrapper  # type: ignore[return-value]
