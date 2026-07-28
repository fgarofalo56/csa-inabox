# GENERATED FILE - DO NOT EDIT BY HAND.
#
# Regenerate with:
#     node sdk/scripts/dump-openapi.mjs
#     python sdk/python/csa-loom/scripts/generate_client.py
#
# Source of truth: apps/fiab-console/lib/openapi/spec.ts (served at
# GET /api/openapi.json). The sdk-contract CI lane regenerates and fails on
# any diff, so this file can never silently drift from the API.

"""The machine-checkable contract between this SDK and the Loom API.

``tests/test_contract.py`` asserts, in both directions, that every entry
here still exists in ``sdk/openapi.json`` and that every operation in the
document has a generated method — so an API change that is not
regenerated fails CI instead of failing a user at runtime.
"""

from __future__ import annotations

from typing import Final, NamedTuple

__all__ = ["OPERATIONS", "SPEC_SHA256", "SPEC_TITLE", "SPEC_VERSION", "GeneratedOperation"]


class GeneratedOperation(NamedTuple):
    """One row of the generated API surface."""

    operation_id: str
    method: str
    path: str
    python_name: str
    path_params: tuple[str, ...]
    query_params: tuple[str, ...]
    request_schema: str | None
    response_schema: str | None


SPEC_TITLE: Final[str] = "CSA Loom API"
SPEC_VERSION: Final[str] = "1.0.0"
#: SHA-256 of sdk/openapi.json at generation time (drift tripwire).
SPEC_SHA256: Final[str] = "b8bea4acf34d5bf3623668c0398527882914c7f9aa374e37ec8566fa05dca798"

OPERATIONS: Final[tuple[GeneratedOperation, ...]] = (
    GeneratedOperation(
        operation_id="whoami",
        method="GET",
        path="/api/v1/whoami",
        python_name="whoami",
        path_params=(),
        query_params=(),
        request_schema=None,
        response_schema="WhoAmI",
    ),
    GeneratedOperation(
        operation_id="me",
        method="GET",
        path="/api/auth/me",
        python_name="me",
        path_params=(),
        query_params=(),
        request_schema=None,
        response_schema="WhoAmI",
    ),
    GeneratedOperation(
        operation_id="listWorkspaces",
        method="GET",
        path="/api/workspaces",
        python_name="list_workspaces",
        path_params=(),
        query_params=("count",),
        request_schema=None,
        response_schema="Workspace[]",
    ),
    GeneratedOperation(
        operation_id="createWorkspace",
        method="POST",
        path="/api/workspaces",
        python_name="create_workspace",
        path_params=(),
        query_params=(),
        request_schema="CreateWorkspace",
        response_schema="Workspace",
    ),
    GeneratedOperation(
        operation_id="listItems",
        method="GET",
        path="/api/workspaces/{workspaceId}/items",
        python_name="list_items",
        path_params=("workspaceId",),
        query_params=(),
        request_schema=None,
        response_schema="Item[]",
    ),
    GeneratedOperation(
        operation_id="createItem",
        method="POST",
        path="/api/workspaces/{workspaceId}/items",
        python_name="create_item",
        path_params=("workspaceId",),
        query_params=(),
        request_schema="CreateItem",
        response_schema="Item",
    ),
    GeneratedOperation(
        operation_id="getItem",
        method="GET",
        path="/api/cosmos-items/{type}/{id}",
        python_name="get_item",
        path_params=("type", "id"),
        query_params=(),
        request_schema=None,
        response_schema="Item",
    ),
    GeneratedOperation(
        operation_id="updateItem",
        method="PATCH",
        path="/api/cosmos-items/{type}/{id}",
        python_name="update_item",
        path_params=("type", "id"),
        query_params=(),
        request_schema="UpdateItem",
        response_schema="Item",
    ),
    GeneratedOperation(
        operation_id="deleteItem",
        method="DELETE",
        path="/api/cosmos-items/{type}/{id}",
        python_name="delete_item",
        path_params=("type", "id"),
        query_params=(),
        request_schema=None,
        response_schema="Ok",
    ),
    GeneratedOperation(
        operation_id="searchCatalog",
        method="GET",
        path="/api/catalog/search",
        python_name="search_catalog",
        path_params=(),
        query_params=("q", "source", "limit"),
        request_schema=None,
        response_schema="CatalogSearchResult",
    ),
    GeneratedOperation(
        operation_id="listThreadEdges",
        method="GET",
        path="/api/thread/edges",
        python_name="list_thread_edges",
        path_params=(),
        query_params=(),
        request_schema=None,
        response_schema="ThreadEdges",
    ),
    GeneratedOperation(
        operation_id="listTokens",
        method="GET",
        path="/api/developer/tokens",
        python_name="list_tokens",
        path_params=(),
        query_params=(),
        request_schema=None,
        response_schema="TokenList",
    ),
    GeneratedOperation(
        operation_id="createToken",
        method="POST",
        path="/api/developer/tokens",
        python_name="create_token",
        path_params=(),
        query_params=(),
        request_schema="CreateToken",
        response_schema="CreateTokenResult",
    ),
    GeneratedOperation(
        operation_id="revokeToken",
        method="DELETE",
        path="/api/developer/tokens/{id}",
        python_name="revoke_token",
        path_params=("id",),
        query_params=(),
        request_schema=None,
        response_schema="Ok",
    ),
    GeneratedOperation(
        operation_id="scimServiceProviderConfig",
        method="GET",
        path="/api/scim/v2/ServiceProviderConfig",
        python_name="scim_service_provider_config",
        path_params=(),
        query_params=(),
        request_schema=None,
        response_schema=None,
    ),
    GeneratedOperation(
        operation_id="scimListUsers",
        method="GET",
        path="/api/scim/v2/Users",
        python_name="scim_list_users",
        path_params=(),
        query_params=("filter", "startIndex", "count"),
        request_schema=None,
        response_schema="ScimListResponse",
    ),
    GeneratedOperation(
        operation_id="scimCreateUser",
        method="POST",
        path="/api/scim/v2/Users",
        python_name="scim_create_user",
        path_params=(),
        query_params=(),
        request_schema="ScimUser",
        response_schema="ScimUser",
    ),
    GeneratedOperation(
        operation_id="scimGetUser",
        method="GET",
        path="/api/scim/v2/Users/{id}",
        python_name="scim_get_user",
        path_params=("id",),
        query_params=(),
        request_schema=None,
        response_schema="ScimUser",
    ),
    GeneratedOperation(
        operation_id="scimReplaceUser",
        method="PUT",
        path="/api/scim/v2/Users/{id}",
        python_name="scim_replace_user",
        path_params=("id",),
        query_params=(),
        request_schema="ScimUser",
        response_schema="ScimUser",
    ),
    GeneratedOperation(
        operation_id="scimPatchUser",
        method="PATCH",
        path="/api/scim/v2/Users/{id}",
        python_name="scim_patch_user",
        path_params=("id",),
        query_params=(),
        request_schema="ScimPatchOp",
        response_schema="ScimUser",
    ),
    GeneratedOperation(
        operation_id="scimDeleteUser",
        method="DELETE",
        path="/api/scim/v2/Users/{id}",
        python_name="scim_delete_user",
        path_params=("id",),
        query_params=(),
        request_schema=None,
        response_schema=None,
    ),
    GeneratedOperation(
        operation_id="scimListGroups",
        method="GET",
        path="/api/scim/v2/Groups",
        python_name="scim_list_groups",
        path_params=(),
        query_params=("filter", "startIndex", "count"),
        request_schema=None,
        response_schema="ScimListResponse",
    ),
    GeneratedOperation(
        operation_id="scimCreateGroup",
        method="POST",
        path="/api/scim/v2/Groups",
        python_name="scim_create_group",
        path_params=(),
        query_params=(),
        request_schema="ScimGroup",
        response_schema="ScimGroup",
    ),
    GeneratedOperation(
        operation_id="scimGetGroup",
        method="GET",
        path="/api/scim/v2/Groups/{id}",
        python_name="scim_get_group",
        path_params=("id",),
        query_params=(),
        request_schema=None,
        response_schema="ScimGroup",
    ),
    GeneratedOperation(
        operation_id="scimReplaceGroup",
        method="PUT",
        path="/api/scim/v2/Groups/{id}",
        python_name="scim_replace_group",
        path_params=("id",),
        query_params=(),
        request_schema="ScimGroup",
        response_schema="ScimGroup",
    ),
    GeneratedOperation(
        operation_id="scimPatchGroup",
        method="PATCH",
        path="/api/scim/v2/Groups/{id}",
        python_name="scim_patch_group",
        path_params=("id",),
        query_params=(),
        request_schema="ScimPatchOp",
        response_schema="ScimGroup",
    ),
    GeneratedOperation(
        operation_id="scimDeleteGroup",
        method="DELETE",
        path="/api/scim/v2/Groups/{id}",
        python_name="scim_delete_group",
        path_params=("id",),
        query_params=(),
        request_schema=None,
        response_schema=None,
    ),
)
