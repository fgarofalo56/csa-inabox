"""csa_platform.streaming.gold — gold contract validation + SLO wiring (CSA-0137).

The :class:`GoldStreamValidator` runs runtime integrity checks on a
:class:`GoldStreamContract` — cross-referencing upstream silver views,
validating consumer identities, and wiring the contract's
:class:`~csa_platform.streaming.models.LatencySLO` into an
:class:`~csa_platform.streaming.slo.SLOMonitor`.

Unlike the models module (which runs structural validation at parse time)
this validator runs *topological* validation across a registry of silver
views.  It is the glue between the static contract and the runtime SLO
monitor.
"""

from __future__ import annotations

from collections.abc import Iterable

from csa_platform.streaming.models import (
    GoldStreamContract,
    SilverMaterializedView,
)
from csa_platform.streaming.slo import SLOMonitor


class GoldContractValidationError(ValueError):
    """Raised when a gold contract fails topological validation."""


class GoldStreamValidator:
    """Validates a gold contract against a registry of silver views."""

    def __init__(self, silver_views: Iterable[SilverMaterializedView]) -> None:
        self._silver_by_name = {sv.name: sv for sv in silver_views}

    def validate(self, gold: GoldStreamContract) -> None:
        """Raise :class:`GoldContractValidationError` on any integrity issue."""
        missing = [
            ref for ref in gold.upstream_silver_refs if ref not in self._silver_by_name
        ]
        if missing:
            raise GoldContractValidationError(
                f"Gold contract {gold.name!r} references unknown silver views: {missing}",
            )
        if not gold.consumers:
            raise GoldContractValidationError(
                f"Gold contract {gold.name!r} has no consumers declared",
            )
        # Consumer identifiers must be non-empty strings.
        for c in gold.consumers:
            if not c or not c.strip():
                raise GoldContractValidationError(
                    f"Gold contract {gold.name!r} contains empty consumer identifier",
                )

    def attach_to_monitor(
        self,
        gold: GoldStreamContract,
        monitor: SLOMonitor,
    ) -> None:
        """Register the gold contract's SLO on a running :class:`SLOMonitor`.

        Calling this after :meth:`validate` means the monitor only ever
        receives contracts that have passed integrity checks.
        """
        self.validate(gold)
        monitor.register(gold.name, gold.latency_slo)
