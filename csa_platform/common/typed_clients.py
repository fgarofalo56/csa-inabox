"""Typed interfaces for the third-party SDK clients used by platform scripts.

Several platform automation scripts (``multi_synapse``, …) talk to Azure
management SDKs whose distributions ship **no inline type information** — most
of the ``azure-mgmt-*`` packages are still untyped as far as mypy is
concerned (they are listed under ``ignore_missing_imports`` in
``pyproject.toml``). Historically the scripts annotated the lazily-constructed
client as ``Any | None`` with a "replace with typed client" placeholder
marker, which silently disabled type-checking for every downstream
``client.*`` call.

This module replaces those ``Any`` placeholders with **structural**
``typing.Protocol`` interfaces that capture *only* the surface each script
actually uses — the sub-service attribute (``client.workspaces``), the
method (``.get(...)``), and the small set of response attributes read back
(``workspace.provisioning_state``, …).

Scope note — when to use a Protocol vs. the real SDK type:

* **SDK ships inline types** (e.g. ``databricks-sdk``, which is fully typed):
  annotate with the *real* client class imported under ``TYPE_CHECKING``.
  That is the strongest form of "typed client" and needs zero maintenance.
* **SDK is untyped** (most ``azure-mgmt-*`` packages): define a structural
  Protocol here capturing the used surface. mypy sees the real object as
  ``Any`` and accepts it against the Protocol, so the *call sites* become
  type-checked without importing the SDK into the typing layer.

Why a Protocol and not a stub package:

* **Runtime is unchanged.** These Protocols are import-only type aliases used
  in annotations under ``if TYPE_CHECKING:``. The scripts still construct the
  real ``SynapseManagementClient`` / ``CostManagementClient`` at runtime;
  nothing here executes.
* **It documents the contract.** The interface is the exact, reviewable list
  of SDK calls a script depends on — a change in SDK shape shows up as a
  type error at the call site instead of an ``AttributeError`` at runtime.

See ``docs/developer/sdk-typing-strategy.md`` for the full rationale and the
recipe for adding a new typed client.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Protocol, TypeVar

_T_co = TypeVar("_T_co", covariant=True)


# ---------------------------------------------------------------------------
# Generic long-running-operation poller (azure-mgmt ``begin_*`` return value)
# ---------------------------------------------------------------------------


class LROPoller(Protocol[_T_co]):
    """Minimal view of an ``azure.core.polling.LROPoller``.

    Only ``result()`` is consumed by the platform scripts; the poller is
    otherwise awaited to completion synchronously.
    """

    def result(self, timeout: float | None = None) -> _T_co:
        """Block until the operation completes and return its result."""
        ...


# ---------------------------------------------------------------------------
# Azure — ``azure.mgmt.synapse.SynapseManagementClient``
# ---------------------------------------------------------------------------


class SynapseWorkspace(Protocol):
    """Workspace resource returned by the Synapse ``workspaces`` operations."""

    id: str | None
    name: str | None
    location: str | None
    provisioning_state: str | None
    managed_virtual_network: Any
    connectivity_endpoints: Mapping[str, str] | None
    tags: Mapping[str, str] | None


class _SynapseWorkspacesOperations(Protocol):
    def begin_create_or_update(
        self,
        resource_group_name: str,
        workspace_name: str,
        workspace_info: Any,
        **kwargs: Any,
    ) -> LROPoller[SynapseWorkspace]:
        ...

    def list_by_resource_group(
        self,
        resource_group_name: str,
        **kwargs: Any,
    ) -> Iterable[SynapseWorkspace]:
        ...

    def get(
        self,
        resource_group_name: str,
        workspace_name: str,
        **kwargs: Any,
    ) -> SynapseWorkspace:
        ...


class _SynapseIpFirewallRulesOperations(Protocol):
    def begin_create_or_update(
        self,
        resource_group_name: str,
        workspace_name: str,
        rule_name: str,
        ip_firewall_rule_info: Any,
        **kwargs: Any,
    ) -> LROPoller[Any]:
        ...


class SynapseManagementClient(Protocol):
    """Structural view of ``azure.mgmt.synapse.SynapseManagementClient``.

    Captures the ``workspaces`` and ``ip_firewall_rules`` operation groups.
    """

    @property
    def workspaces(self) -> _SynapseWorkspacesOperations:
        ...

    @property
    def ip_firewall_rules(self) -> _SynapseIpFirewallRulesOperations:
        ...


# ---------------------------------------------------------------------------
# Azure — ``azure.mgmt.costmanagement.CostManagementClient``
# ---------------------------------------------------------------------------


class CostQueryColumn(Protocol):
    """A single column descriptor in a Cost Management query result."""

    name: str | None


class CostQueryResult(Protocol):
    """Result of ``query.usage`` — a columnar table of cost rows."""

    columns: Sequence[CostQueryColumn] | None
    rows: Sequence[Sequence[Any]] | None


class _CostQueryOperations(Protocol):
    def usage(self, scope: str, parameters: Any, **kwargs: Any) -> CostQueryResult:
        ...


class CostManagementClient(Protocol):
    """Structural view of ``azure.mgmt.costmanagement.CostManagementClient``.

    Captures the single ``query`` operation group used for chargeback.
    """

    @property
    def query(self) -> _CostQueryOperations:
        ...


__all__ = [
    "CostManagementClient",
    "CostQueryColumn",
    "CostQueryResult",
    "LROPoller",
    "SynapseManagementClient",
    "SynapseWorkspace",
]
