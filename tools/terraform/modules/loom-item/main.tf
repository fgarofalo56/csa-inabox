# A Loom item inside a workspace.
#
# Create and read/update/delete use DIFFERENT paths (matching the API):
#   create : POST   /api/workspaces/{workspaceId}/items
#   read   : GET    /api/cosmos-items/{type}/{id}
#   update : PATCH  /api/cosmos-items/{type}/{id}
#   delete : DELETE /api/cosmos-items/{type}/{id}
#
# The restapi provider supports per-verb path overrides, so we point `path`
# (read/update/delete base, "/{id}" appended) at the cosmos-items typed CRUD and
# override `create_path` to the workspace items collection.

locals {
  item_body = merge(
    {
      itemType    = var.item_type
      displayName = var.display_name
    },
    var.description == null ? {} : { description = var.description },
  )
}

resource "restapi_object" "item" {
  # Read/update/delete base — provider appends "/{id}".
  path = "/api/cosmos-items/${var.item_type}"

  # Create posts to the workspace items collection instead.
  create_path   = "/api/workspaces/${var.workspace_id}/items"
  create_method = "POST"
  update_method = "PATCH"

  id_attribute = "id"

  data = jsonencode(local.item_body)
}
