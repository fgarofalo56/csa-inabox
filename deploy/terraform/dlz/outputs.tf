# =============================================================================
# DLZ (Data Landing Zone) — Outputs
# Mirrors outputs from: deploy/bicep/DLZ/main.bicep
# =============================================================================

# --- Storage ---
output "storage_account_id" {
  description = "Resource ID of the Data Lake storage account."
  value       = var.deploy_storage ? module.storage[0].storage_account_id : ""
}

# --- Cosmos DB ---
output "cosmosdb_account_id" {
  description = "Resource ID of the Cosmos DB account."
  value       = var.deploy_cosmosdb ? module.cosmosdb[0].account_id : ""
}

# --- Synapse ---
output "synapse_workspace_id" {
  description = "Resource ID of the Synapse workspace."
  value       = var.deploy_synapse ? module.synapse[0].workspace_id : ""
}

output "synapse_identity_principal_id" {
  description = "Managed identity principal ID of Synapse."
  value       = var.deploy_synapse ? module.synapse[0].identity_principal_id : ""
}

# --- Databricks ---
output "databricks_workspace_id" {
  description = "Resource ID of the Databricks workspace."
  value       = var.deploy_databricks ? module.databricks[0].workspace_id : ""
}

output "databricks_workspace_url" {
  description = "URL of the Databricks workspace."
  value       = var.deploy_databricks ? module.databricks[0].workspace_url : ""
}

# --- Data Factory ---
output "data_factory_id" {
  description = "Resource ID of the Data Factory."
  value       = var.deploy_data_factory ? module.datafactory[0].factory_id : ""
}

output "data_factory_identity_principal_id" {
  description = "Managed identity principal ID of Data Factory."
  value       = var.deploy_data_factory ? module.datafactory[0].identity_principal_id : ""
}

# --- Event Hubs ---
output "eventhubs_namespace_id" {
  description = "Resource ID of the Event Hubs namespace."
  value       = var.deploy_event_hubs ? module.eventhubs[0].namespace_id : ""
}

# --- Data Explorer ---
output "data_explorer_cluster_id" {
  description = "Resource ID of the Data Explorer cluster."
  value       = var.deploy_data_explorer ? module.dataexplorer[0].cluster_id : ""
}

# --- Machine Learning ---
output "machine_learning_workspace_id" {
  description = "Resource ID of the Machine Learning workspace."
  value       = var.deploy_machine_learning ? module.machinelearning[0].workspace_id : ""
}

# --- App Insights ---
output "app_insights_id" {
  description = "Resource ID of Application Insights."
  value       = var.deploy_app_insights ? module.monitoring[0].app_insights_id : ""
}

# --- Functions ---
output "functions_app_id" {
  description = "Resource ID of the Function App."
  value       = var.deploy_functions ? module.functions[0].function_app_id : ""
}

# --- Stream Analytics ---
output "stream_analytics_job_id" {
  description = "Resource ID of the Stream Analytics job."
  value       = var.deploy_stream_analytics ? module.streamanalytics[0].job_id : ""
}
