# GENERATED FILE - DO NOT EDIT BY HAND.
#
# Regenerate with:
#     node sdk/scripts/dump-openapi.mjs
#     python sdk/python/csa-loom/scripts/generate_client.py
#
# Source of truth: apps/fiab-console/lib/openapi/spec.ts (served at
# GET /api/openapi.json). The sdk-contract CI lane regenerates and fails on
# any diff, so this file can never silently drift from the API.

"""Typed shapes for every schema in the Loom OpenAPI document.

Each entry of ``components.schemas`` becomes a ``TypedDict``. Keys the
document marks required are required; everything else is ``NotRequired``.
Property names are kept EXACTLY as the API emits them (camelCase) so a
response dict validates against the TypedDict without translation.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, NotRequired, TypedDict

__all__ = [
    "CatalogHit",
    "CatalogSearchResult",
    "CreateItem",
    "CreateToken",
    "CreateTokenResult",
    "CreateWorkspace",
    "Error",
    "Item",
    "ItemDefinition",
    "ItemDefinitionResult",
    "Ok",
    "ScimError",
    "ScimGroup",
    "ScimListResponse",
    "ScimMeta",
    "ScimPatchOp",
    "ScimUser",
    "ThreadEdges",
    "TokenList",
    "TokenView",
    "UpdateItem",
    "UpdateItemDefinition",
    "WhoAmI",
    "Workspace",
]


class Ok(TypedDict):
    """``Ok`` — ``components.schemas.Ok`` of the Loom OpenAPI document.

    The API may return additional keys beyond those listed.
    """

    ok: bool


class Error(TypedDict):
    """``Error`` — ``components.schemas.Error`` of the Loom OpenAPI document."""

    ok: bool
    #: Human-readable error message.
    error: str
    #: Stable machine-readable error code.
    code: NotRequired[str]
    #: Optional remediation hint (honest infra gates).
    hint: NotRequired[str]


class WhoAmI(TypedDict):
    """``WhoAmI`` — ``components.schemas.WhoAmI`` of the Loom OpenAPI document."""

    ok: bool
    auth: Literal["cookie", "pat"]
    #: Entra object id of the caller.
    oid: str
    upn: NotRequired[str]
    name: NotRequired[str]
    tenantId: str
    #: Present only for a PAT session.
    scope: NotRequired[Literal["read-only", "read-write", "admin"]]
    #: Present only for a PAT session.
    tokenId: NotRequired[str]


class Workspace(TypedDict):
    """``Workspace`` — ``components.schemas.Workspace`` of the Loom OpenAPI document."""

    id: str
    name: str
    description: NotRequired[str]
    capacity: NotRequired[str]
    domain: NotRequired[str]
    createdBy: NotRequired[str]
    createdAt: NotRequired[str]
    updatedAt: NotRequired[str]
    #: Present only when `?count=true`.
    itemCount: NotRequired[int]


class CreateWorkspace(TypedDict):
    """``CreateWorkspace`` — ``components.schemas.CreateWorkspace`` of the Loom OpenAPI document."""

    name: str
    description: NotRequired[str]
    #: Optional capacity binding.
    capacity: NotRequired[str]
    #: Governance domain id (defaults to `default`).
    domain: NotRequired[str]


class Item(TypedDict):
    """``Item`` — ``components.schemas.Item`` of the Loom OpenAPI document."""

    id: str
    workspaceId: str
    itemType: str
    displayName: str
    description: NotRequired[str]
    #: Per-item-type editor state.
    state: NotRequired[Mapping[str, Any]]
    createdAt: NotRequired[str]
    updatedAt: NotRequired[str]


class CreateItem(TypedDict):
    """``CreateItem`` — ``components.schemas.CreateItem`` of the Loom OpenAPI document."""

    #: One of the ~120 Azure-native item types.
    itemType: str
    displayName: str
    description: NotRequired[str]


class UpdateItem(TypedDict):
    """``UpdateItem`` — ``components.schemas.UpdateItem`` of the Loom OpenAPI document."""

    displayName: NotRequired[str]
    description: NotRequired[str]
    state: NotRequired[Mapping[str, Any]]


class ItemDefinition(TypedDict):
    """A single item's portable, secret-scrubbed, provisioning-free definition."""

    #: Definition schema version this document conforms to (currently 1). A PUT declaring a higher version is refused (409).
    schemaVersion: int
    itemType: str
    displayName: str
    description: NotRequired[str]
    #: Portable editor state with secret-keyed leaves and `provisioning` excluded.
    state: Mapping[str, Any]


class ItemDefinitionResult(TypedDict):
    """``ItemDefinitionResult`` — ``components.schemas.ItemDefinitionResult`` of the Loom OpenAPI document."""

    ok: bool
    itemType: str
    definition: ItemDefinition
    schemaVersion: int
    #: Strong validator (also sent as the `ETag` header) to echo as `If-Match` on write.
    etag: str
    #: `state/<dot.path>` for every secret leaf excluded from `definition.state`.
    scrubbedPaths: list[str]
    #: True when `state.provisioning` was present and excluded.
    provisioningExcluded: bool


class UpdateItemDefinition(TypedDict):
    """Body of `PUT …/definition`. The edited definition — a bare definition object is also accepted for backwards compatibility."""

    definition: ItemDefinition


class CatalogSearchResult(TypedDict):
    """``CatalogSearchResult`` — ``components.schemas.CatalogSearchResult`` of the Loom OpenAPI document."""

    ok: bool
    total: NotRequired[int]
    hits: list[CatalogHit]
    sources: NotRequired[Mapping[str, Any]]


class CatalogHit(TypedDict):
    """``CatalogHit`` — ``components.schemas.CatalogHit`` of the Loom OpenAPI document."""

    source: Literal["purview", "unity-catalog", "onelake"]
    id: str
    display_name: str
    type: str
    description: NotRequired[str]
    owner: NotRequired[str]
    workspace_name: NotRequired[str]
    workspace_id: NotRequired[str]
    domain: NotRequired[str]


class ThreadEdges(TypedDict):
    """``ThreadEdges`` — ``components.schemas.ThreadEdges`` of the Loom OpenAPI document."""

    ok: bool
    edges: list[Mapping[str, Any]]


class TokenList(TypedDict):
    """``TokenList`` — ``components.schemas.TokenList`` of the Loom OpenAPI document."""

    ok: bool
    tokens: list[TokenView]
    maxTtlDays: NotRequired[int]
    defaultTtlDays: NotRequired[int]


class TokenView(TypedDict):
    """``TokenView`` — ``components.schemas.TokenView`` of the Loom OpenAPI document."""

    id: str
    name: str
    scope: Literal["read-only", "read-write", "admin"]
    createdByUpn: NotRequired[str]
    createdAt: str
    expiresAt: str
    lastUsedAt: NotRequired[str]
    revoked: bool
    expired: NotRequired[bool]


class CreateToken(TypedDict):
    """``CreateToken`` — ``components.schemas.CreateToken`` of the Loom OpenAPI document."""

    name: str
    scope: Literal["read-only", "read-write", "admin"]
    #: Token lifetime in days (default 30, max 90).
    ttlDays: NotRequired[int]


class CreateTokenResult(TypedDict):
    """``CreateTokenResult`` — ``components.schemas.CreateTokenResult`` of the Loom OpenAPI document."""

    ok: bool
    #: The full token string — shown ONCE, unrecoverable after.
    token: str
    tokenInfo: TokenView


class ScimUser(TypedDict):
    """``ScimUser`` — ``components.schemas.ScimUser`` of the Loom OpenAPI document."""

    schemas: list[str]
    id: NotRequired[str]
    externalId: NotRequired[str]
    userName: str
    active: NotRequired[bool]
    displayName: NotRequired[str]
    name: NotRequired[Mapping[str, Any]]
    emails: NotRequired[list[Mapping[str, Any]]]
    groups: NotRequired[list[Mapping[str, Any]]]
    meta: NotRequired[ScimMeta]


class ScimGroup(TypedDict):
    """``ScimGroup`` — ``components.schemas.ScimGroup`` of the Loom OpenAPI document."""

    schemas: list[str]
    id: NotRequired[str]
    externalId: NotRequired[str]
    displayName: str
    members: NotRequired[list[Mapping[str, Any]]]
    meta: NotRequired[ScimMeta]


class ScimMeta(TypedDict):
    """``ScimMeta`` — ``components.schemas.ScimMeta`` of the Loom OpenAPI document."""

    resourceType: NotRequired[str]
    created: NotRequired[str]
    lastModified: NotRequired[str]
    location: NotRequired[str]
    #: Weak ETag.
    version: NotRequired[str]


class ScimListResponse(TypedDict):
    """``ScimListResponse`` — ``components.schemas.ScimListResponse`` of the Loom OpenAPI document."""

    schemas: list[str]
    totalResults: int
    startIndex: NotRequired[int]
    itemsPerPage: NotRequired[int]
    Resources: list[Mapping[str, Any]]


class ScimPatchOp(TypedDict):
    """``ScimPatchOp`` — ``components.schemas.ScimPatchOp`` of the Loom OpenAPI document."""

    schemas: list[str]
    Operations: list[Mapping[str, Any]]


class ScimError(TypedDict):
    """``ScimError`` — ``components.schemas.ScimError`` of the Loom OpenAPI document."""

    schemas: list[str]
    status: str
    scimType: NotRequired[str]
    detail: NotRequired[str]
