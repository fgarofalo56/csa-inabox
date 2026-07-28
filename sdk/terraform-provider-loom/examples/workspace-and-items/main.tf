# A workspace plus two Azure-native items. Nothing here requires a Microsoft
# Fabric tenant: `lakehouse` is ADLS Gen2 + Delta, `notebook` runs on Synapse
# Spark — the Azure-native defaults.

resource "loom_workspace" "analytics" {
  name        = "analytics"
  description = "Managed by Terraform"
  domain      = "default"
}

resource "loom_item" "bronze" {
  workspace_id = loom_workspace.analytics.id
  item_type    = "lakehouse"
  display_name = "bronze"
  description  = "Raw landing zone"
}

resource "loom_item" "exploration" {
  workspace_id = loom_workspace.analytics.id
  item_type    = "notebook"
  display_name = "exploration"

  # Editor state is optional. Supply it only for the item types you intend to
  # manage as code; omit it and the console owns the editor state.
  state_json = jsonencode({
    language = "python"
  })
}

# Attach items to a workspace someone else created in the console.
data "loom_workspace" "shared" {
  name = "platform-shared"
}

output "analytics_workspace_id" {
  value = loom_workspace.analytics.id
}

output "shared_workspace_item_count" {
  value = data.loom_workspace.shared.item_count
}
