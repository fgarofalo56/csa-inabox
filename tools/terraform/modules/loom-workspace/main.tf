# A Loom workspace, provisioned via POST /api/workspaces and managed by id
# through GET/PATCH/DELETE /api/workspaces/{id}.
#
# The restapi provider is configured by the ROOT module (uri + Authorization
# header); this module only declares the resource so it can be reused and its
# provider inherited.

locals {
  # Only send keys the caller set — the API defaults description/capacity/domain.
  workspace_body = merge(
    { name = var.name },
    var.description == null ? {} : { description = var.description },
    var.capacity == null ? {} : { capacity = var.capacity },
    var.domain == null ? {} : { domain = var.domain },
  )
}

resource "restapi_object" "workspace" {
  # Base path for read/update/delete — the provider appends "/{id}".
  path = "/api/workspaces"

  # POST /api/workspaces returns 201 with the created workspace (incl. id).
  create_method = "POST"
  update_method = "PATCH"

  # The workspace id lives at `.id` in the response body.
  id_attribute = "id"

  data = jsonencode(local.workspace_body)
}
