---
title: CSA-in-a-Box — SDK typing strategy
date: 2026-07-20
---

# SDK typing strategy

How the platform Python code stays type-safe when it talks to third-party
SDKs whose distributions ship **incomplete or missing** type information —
principally the Azure management SDKs (`azure-mgmt-*`) and, historically, the
Databricks SDK.

This document is the canonical guidance behind workstream **WS-I** of the
remediation backlog. It exists so contributors stop reaching for the anti-pattern
it replaces:

```python
# ANTI-PATTERN — do not do this
self._client: Any | None = None  # TODO: Replace with typed client
```

Annotating a client as `Any` silently disables type-checking for **every**
downstream `client.*` call — an SDK rename becomes a runtime `AttributeError`
instead of a mypy error. WS-I removed the last of these placeholders from the
platform scripts.

---

## The decision rule

When you construct a third-party SDK client, pick the annotation by whether the
SDK ships inline types:

| Situation | What to annotate with | Why |
|-----------|-----------------------|-----|
| **SDK ships inline types** (has `py.typed`; mypy resolves its classes) — e.g. `databricks-sdk` | The **real client class**, imported under `TYPE_CHECKING` | Strongest form of "typed client", zero maintenance, exact signatures |
| **SDK is untyped** (listed under `[[tool.mypy.overrides]] ignore_missing_imports` in `pyproject.toml`) — e.g. most `azure-mgmt-*` | A **structural `typing.Protocol`** in `csa_platform/common/typed_clients.py` capturing only the surface you use | mypy sees the object as `Any` and accepts it against the Protocol, so the *call sites* become type-checked without importing the SDK into the typing layer |

Both keep **runtime behavior identical**: the client is still constructed
lazily from the real SDK inside `_get_client()`. The annotations are used only
by mypy / IDEs and (for the untyped case) live under `if TYPE_CHECKING:`.

To find out which bucket an SDK is in:

```bash
# Untyped SDKs are enumerated here (ignore_missing_imports = true):
grep -A40 'Third-party packages that do not ship inline type stubs' pyproject.toml
```

---

## Pattern A — real SDK type (typed SDKs)

Used by the semantic-model scripts for `databricks-sdk` (which is fully typed):

```python
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from databricks.sdk import WorkspaceClient


class SemanticModelGenerator:
    def __init__(self, workspace_url: str = "", token: str = "") -> None:
        self._client: WorkspaceClient | None = None

    def _get_client(self) -> WorkspaceClient:
        if self._client is not None:
            return self._client
        from databricks.sdk import WorkspaceClient  # lazy, real import
        self._client = WorkspaceClient(host=self.workspace_url, token=self._token or None)
        return self._client
```

`from __future__ import annotations` makes the annotations strings, so the
`TYPE_CHECKING`-only import never runs at runtime — importing the module with
the SDK absent still works, exactly as before.

A useful side effect: once the client is typed, mypy surfaces **latent
None-safety** issues the `Any` hid (e.g. a nullable `warehouse.name` flowing
into a `str` field). Fix those with the existing defensive idiom
(`warehouse.name or ""`), which is behavior-identical. When the SDK genuinely
accepts a looser shape than its own type hints admit (e.g. the Databricks SDK
accepts a plain dict where it types `EndpointTags`), narrow the exception with
a **targeted, commented** override rather than reverting to `Any`:

```python
tags={"custom_tags": [...]} if config.tags else None,  # type: ignore[arg-type]
```

---

## Pattern B — structural Protocol (untyped SDKs)

Used by the multi-synapse scripts for `azure-mgmt-synapse` and
`azure-mgmt-costmanagement`. Define the Protocol in
`csa_platform/common/typed_clients.py`, capturing **only** the sub-services,
methods, and response attributes the caller touches:

```python
# csa_platform/common/typed_clients.py
from __future__ import annotations
from collections.abc import Iterable, Mapping
from typing import Any, Protocol


class SynapseWorkspace(Protocol):
    name: str | None
    location: str | None
    provisioning_state: str | None
    connectivity_endpoints: Mapping[str, str] | None


class _SynapseWorkspacesOperations(Protocol):
    def list_by_resource_group(self, resource_group_name: str, **kwargs: Any) -> Iterable[SynapseWorkspace]: ...
    def get(self, resource_group_name: str, workspace_name: str, **kwargs: Any) -> SynapseWorkspace: ...


class SynapseManagementClient(Protocol):
    @property
    def workspaces(self) -> _SynapseWorkspacesOperations: ...
```

And in the script:

```python
if TYPE_CHECKING:
    from azure.core.credentials import TokenCredential
    from csa_platform.common.typed_clients import SynapseManagementClient


class SynapseWorkspaceManager:
    def __init__(self, subscription_id: str, credential: TokenCredential | None = None) -> None:
        self._client: SynapseManagementClient | None = None

    def _get_client(self) -> SynapseManagementClient:
        if self._client is not None:
            return self._client
        # Alias the real class so the Protocol name stays unambiguous in annotations.
        from azure.mgmt.synapse import SynapseManagementClient as _SynapseManagementClient
        client: SynapseManagementClient = _SynapseManagementClient(
            credential=self._credential, subscription_id=self.subscription_id,
        )
        self._client = client
        return client
```

Guidelines for writing a Protocol:

- **Capture only what you call.** Add a method/attribute when a caller uses it,
  not speculatively. The Protocol is a reviewable contract of the real
  dependency surface.
- **Model sub-services as read-only `@property`** returning a nested Protocol —
  this matches SDK clients that expose operation groups as properties.
- **Response objects** get their own Protocol listing just the attributes read;
  nullable SDK fields stay `str | None` etc. so callers must handle `None`.
- **SDK-owned enums / model objects** that you only pass through can be typed
  `Any` — you are not re-declaring the SDK's whole type graph.
- **Long-running operations** (`begin_*`) return the shared generic
  `LROPoller[T]` Protocol already defined in the module.

---

## Adding a new typed client — checklist

1. Is the SDK typed? (`grep` the `ignore_missing_imports` list, or run
   `mypy -c "import the_sdk"`.) If yes → **Pattern A**, done.
2. If no → add a Protocol to `csa_platform/common/typed_clients.py` capturing
   the used surface; export it in `__all__`.
3. Annotate `self._client` and `_get_client()`'s return with it; import the
   Protocol under `if TYPE_CHECKING:`.
4. Alias the real SDK class on the lazy `import ... as _Foo` line so the
   Protocol name is unambiguous in annotations.
5. Run `mypy --ignore-missing-imports <file>` and resolve any latent
   None-safety findings with the `or ""` idiom or a targeted, commented
   `# type: ignore[<code>]`.
6. Keep runtime untouched — annotations only.

---

## References

- Interfaces: `csa_platform/common/typed_clients.py`
- Applied in: `csa_platform/semantic_model/scripts/*.py`,
  `csa_platform/multi_synapse/scripts/*.py`
- mypy config + untyped-SDK list: `pyproject.toml` (`[tool.mypy]`)
- Contributor entry point: [Developer Pathways](../DEVELOPER_PATHWAYS.md)
