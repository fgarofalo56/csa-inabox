# GENERATED FILE - DO NOT EDIT BY HAND.
#
# Regenerate with:
#     node sdk/scripts/dump-openapi.mjs
#     python sdk/python/csa-loom/scripts/generate_client.py
#
# Source of truth: apps/fiab-console/lib/openapi/spec.ts (served at
# GET /api/openapi.json). The sdk-contract CI lane regenerates and fails on
# any diff, so this file can never silently drift from the API.

"""One typed method per ``operationId`` in the Loom OpenAPI document.

``_GeneratedOperations`` is a mixin: it owns NO transport. ``LoomClient``
supplies ``_request``; every method below is a thin, fully-typed shim over
it, so the hand-written transport and the generated surface can never
disagree about a route.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from csa_loom._paths import expand

from .models import (
    CatalogSearchResult,
    CreateItem,
    CreateToken,
    CreateTokenResult,
    CreateWorkspace,
    Item,
    Ok,
    ScimGroup,
    ScimListResponse,
    ScimPatchOp,
    ScimUser,
    ThreadEdges,
    TokenList,
    UpdateItem,
    WhoAmI,
    Workspace,
)

__all__ = ["_GeneratedOperations"]


class _GeneratedOperations:
    """Generated API surface. Mixed into :class:`csa_loom.LoomClient`."""

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        content_type: str | None = None,
        accept: str | None = None,
    ) -> Any:
        """Perform one HTTP call. Implemented by :class:`csa_loom.LoomClient`."""
        raise NotImplementedError  # pragma: no cover - overridden by LoomClient

    def whoami(self) -> WhoAmI:
        """Echo the caller identity + token scope.

        ``GET /api/v1/whoami`` (operationId ``whoami``).

        The canonical "is my token working / what can it do" probe. Accepts a cookie
        session or a PAT and returns only the caller's own identity — no cross-tenant
        data.
        """
        path = "/api/v1/whoami"
        query: dict[str, Any] | None = None
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(WhoAmI, result)

    def me(self) -> WhoAmI:
        """Probe the current browser/CLI session.

        ``GET /api/auth/me`` (operationId ``me``).
        """
        path = "/api/auth/me"
        query: dict[str, Any] | None = None
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(WhoAmI, result)

    def list_workspaces(
        self,
        *,
        count: bool | None = None,
    ) -> list[Workspace]:
        """List workspaces accessible to the caller.

        ``GET /api/workspaces`` (operationId ``listWorkspaces``).
        """
        path = "/api/workspaces"
        query: dict[str, Any] = {}
        if count is not None:
            query["count"] = count
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(list[Workspace], result)

    def create_workspace(
        self,
        *,
        body: CreateWorkspace,
    ) -> Workspace:
        """Create a workspace.

        ``POST /api/workspaces`` (operationId ``createWorkspace``).
        """
        path = "/api/workspaces"
        query: dict[str, Any] | None = None
        result = self._request(
            "POST",
            path,
            query=query,
            body=body,
            content_type="application/json",
            accept="application/json",
        )
        return cast(Workspace, result)

    def list_items(
        self,
        workspace_id: str,
    ) -> list[Item]:
        """List items in a workspace.

        ``GET /api/workspaces/{workspaceId}/items`` (operationId ``listItems``).
        """
        path = expand("/api/workspaces/{workspaceId}/items", {"workspaceId": workspace_id})
        query: dict[str, Any] | None = None
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(list[Item], result)

    def create_item(
        self,
        workspace_id: str,
        *,
        body: CreateItem,
    ) -> Item:
        """Create an item in a workspace.

        ``POST /api/workspaces/{workspaceId}/items`` (operationId ``createItem``).
        """
        path = expand("/api/workspaces/{workspaceId}/items", {"workspaceId": workspace_id})
        query: dict[str, Any] | None = None
        result = self._request(
            "POST",
            path,
            query=query,
            body=body,
            content_type="application/json",
            accept="application/json",
        )
        return cast(Item, result)

    def get_item(
        self,
        type_: str,
        id_: str,
    ) -> Item:
        """Get an item by type + id.

        ``GET /api/cosmos-items/{type}/{id}`` (operationId ``getItem``).
        """
        path = expand("/api/cosmos-items/{type}/{id}", {"type": type_, "id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(Item, result)

    def update_item(
        self,
        type_: str,
        id_: str,
        *,
        body: UpdateItem,
    ) -> Item:
        """Update an item's name / description / state.

        ``PATCH /api/cosmos-items/{type}/{id}`` (operationId ``updateItem``).
        """
        path = expand("/api/cosmos-items/{type}/{id}", {"type": type_, "id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "PATCH",
            path,
            query=query,
            body=body,
            content_type="application/json",
            accept="application/json",
        )
        return cast(Item, result)

    def delete_item(
        self,
        type_: str,
        id_: str,
    ) -> Ok:
        """Delete an item.

        ``DELETE /api/cosmos-items/{type}/{id}`` (operationId ``deleteItem``).
        """
        path = expand("/api/cosmos-items/{type}/{id}", {"type": type_, "id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "DELETE",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(Ok, result)

    def search_catalog(
        self,
        *,
        q: str | None = None,
        source: str | None = None,
        limit: int | None = None,
    ) -> CatalogSearchResult:
        """Federated catalog search.

        ``GET /api/catalog/search`` (operationId ``searchCatalog``).
        """
        path = "/api/catalog/search"
        query: dict[str, Any] = {}
        if q is not None:
            query["q"] = q
        if source is not None:
            query["source"] = source
        if limit is not None:
            query["limit"] = limit
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(CatalogSearchResult, result)

    def list_thread_edges(self) -> ThreadEdges:
        """The caller's Loom Thread (Weave) edge graph.

        ``GET /api/thread/edges`` (operationId ``listThreadEdges``).
        """
        path = "/api/thread/edges"
        query: dict[str, Any] | None = None
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(ThreadEdges, result)

    def list_tokens(self) -> TokenList:
        """List the caller's API tokens (safe view).

        ``GET /api/developer/tokens`` (operationId ``listTokens``).

        Cookie-only. A PAT can never manage tokens.
        """
        path = "/api/developer/tokens"
        query: dict[str, Any] | None = None
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(TokenList, result)

    def create_token(
        self,
        *,
        body: CreateToken,
    ) -> CreateTokenResult:
        """Create an API token (returns the secret once).

        ``POST /api/developer/tokens`` (operationId ``createToken``).
        """
        path = "/api/developer/tokens"
        query: dict[str, Any] | None = None
        result = self._request(
            "POST",
            path,
            query=query,
            body=body,
            content_type="application/json",
            accept="application/json",
        )
        return cast(CreateTokenResult, result)

    def revoke_token(
        self,
        id_: str,
    ) -> Ok:
        """Revoke one of the caller's tokens.

        ``DELETE /api/developer/tokens/{id}`` (operationId ``revokeToken``).
        """
        path = expand("/api/developer/tokens/{id}", {"id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "DELETE",
            path,
            query=query,
            body=None,
            accept="application/json",
        )
        return cast(Ok, result)

    def scim_service_provider_config(self) -> Mapping[str, Any]:
        """SCIM service-provider capabilities (RFC 7643 §5).

        ``GET /api/scim/v2/ServiceProviderConfig`` (operationId ``scimServiceProviderConfig``).
        """
        path = "/api/scim/v2/ServiceProviderConfig"
        query: dict[str, Any] | None = None
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/scim+json",
        )
        return cast(Mapping[str, Any], result)

    def scim_list_users(
        self,
        *,
        filter_: str | None = None,
        start_index: int | None = None,
        count: int | None = None,
    ) -> ScimListResponse:
        """List / filter SCIM users.

        ``GET /api/scim/v2/Users`` (operationId ``scimListUsers``).
        """
        path = "/api/scim/v2/Users"
        query: dict[str, Any] = {}
        if filter_ is not None:
            query["filter"] = filter_
        if start_index is not None:
            query["startIndex"] = start_index
        if count is not None:
            query["count"] = count
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/scim+json",
        )
        return cast(ScimListResponse, result)

    def scim_create_user(
        self,
        *,
        body: ScimUser,
    ) -> ScimUser:
        """Provision a user.

        ``POST /api/scim/v2/Users`` (operationId ``scimCreateUser``).
        """
        path = "/api/scim/v2/Users"
        query: dict[str, Any] | None = None
        result = self._request(
            "POST",
            path,
            query=query,
            body=body,
            content_type="application/scim+json",
            accept="application/scim+json",
        )
        return cast(ScimUser, result)

    def scim_get_user(
        self,
        id_: str,
    ) -> ScimUser:
        """Get a user.

        ``GET /api/scim/v2/Users/{id}`` (operationId ``scimGetUser``).
        """
        path = expand("/api/scim/v2/Users/{id}", {"id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/scim+json",
        )
        return cast(ScimUser, result)

    def scim_replace_user(
        self,
        id_: str,
        *,
        body: ScimUser,
    ) -> ScimUser:
        """Replace a user.

        ``PUT /api/scim/v2/Users/{id}`` (operationId ``scimReplaceUser``).
        """
        path = expand("/api/scim/v2/Users/{id}", {"id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "PUT",
            path,
            query=query,
            body=body,
            content_type="application/scim+json",
            accept="application/scim+json",
        )
        return cast(ScimUser, result)

    def scim_patch_user(
        self,
        id_: str,
        *,
        body: ScimPatchOp,
    ) -> ScimUser:
        """Patch a user (e.g. deactivate).

        ``PATCH /api/scim/v2/Users/{id}`` (operationId ``scimPatchUser``).
        """
        path = expand("/api/scim/v2/Users/{id}", {"id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "PATCH",
            path,
            query=query,
            body=body,
            content_type="application/scim+json",
            accept="application/scim+json",
        )
        return cast(ScimUser, result)

    def scim_delete_user(
        self,
        id_: str,
    ) -> None:
        """Deprovision a user.

        ``DELETE /api/scim/v2/Users/{id}`` (operationId ``scimDeleteUser``).
        """
        path = expand("/api/scim/v2/Users/{id}", {"id": id_})
        query: dict[str, Any] | None = None
        self._request(
            "DELETE",
            path,
            query=query,
            body=None,
        )

    def scim_list_groups(
        self,
        *,
        filter_: str | None = None,
        start_index: int | None = None,
        count: int | None = None,
    ) -> ScimListResponse:
        """List / filter SCIM groups.

        ``GET /api/scim/v2/Groups`` (operationId ``scimListGroups``).
        """
        path = "/api/scim/v2/Groups"
        query: dict[str, Any] = {}
        if filter_ is not None:
            query["filter"] = filter_
        if start_index is not None:
            query["startIndex"] = start_index
        if count is not None:
            query["count"] = count
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/scim+json",
        )
        return cast(ScimListResponse, result)

    def scim_create_group(
        self,
        *,
        body: ScimGroup,
    ) -> ScimGroup:
        """Provision a group.

        ``POST /api/scim/v2/Groups`` (operationId ``scimCreateGroup``).
        """
        path = "/api/scim/v2/Groups"
        query: dict[str, Any] | None = None
        result = self._request(
            "POST",
            path,
            query=query,
            body=body,
            content_type="application/scim+json",
            accept="application/scim+json",
        )
        return cast(ScimGroup, result)

    def scim_get_group(
        self,
        id_: str,
    ) -> ScimGroup:
        """Get a group.

        ``GET /api/scim/v2/Groups/{id}`` (operationId ``scimGetGroup``).
        """
        path = expand("/api/scim/v2/Groups/{id}", {"id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "GET",
            path,
            query=query,
            body=None,
            accept="application/scim+json",
        )
        return cast(ScimGroup, result)

    def scim_replace_group(
        self,
        id_: str,
        *,
        body: ScimGroup,
    ) -> ScimGroup:
        """Replace a group.

        ``PUT /api/scim/v2/Groups/{id}`` (operationId ``scimReplaceGroup``).
        """
        path = expand("/api/scim/v2/Groups/{id}", {"id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "PUT",
            path,
            query=query,
            body=body,
            content_type="application/scim+json",
            accept="application/scim+json",
        )
        return cast(ScimGroup, result)

    def scim_patch_group(
        self,
        id_: str,
        *,
        body: ScimPatchOp,
    ) -> ScimGroup:
        """Patch a group's members.

        ``PATCH /api/scim/v2/Groups/{id}`` (operationId ``scimPatchGroup``).
        """
        path = expand("/api/scim/v2/Groups/{id}", {"id": id_})
        query: dict[str, Any] | None = None
        result = self._request(
            "PATCH",
            path,
            query=query,
            body=body,
            content_type="application/scim+json",
            accept="application/scim+json",
        )
        return cast(ScimGroup, result)

    def scim_delete_group(
        self,
        id_: str,
    ) -> None:
        """Delete a group.

        ``DELETE /api/scim/v2/Groups/{id}`` (operationId ``scimDeleteGroup``).
        """
        path = expand("/api/scim/v2/Groups/{id}", {"id": id_})
        query: dict[str, Any] | None = None
        self._request(
            "DELETE",
            path,
            query=query,
            body=None,
        )
