# =============================================================================
# Stream Analytics Module — Outputs
# =============================================================================

output "job_id" {
  description = "Resource ID of the Stream Analytics job."
  value       = azurerm_stream_analytics_job.this.id
}

output "job_name" {
  description = "Name of the Stream Analytics job."
  value       = azurerm_stream_analytics_job.this.name
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = azurerm_stream_analytics_job.this.identity[0].principal_id
}
