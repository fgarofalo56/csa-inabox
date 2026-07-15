output "workspace_id" {
  description = "The id of the created workspace."
  value       = module.workspace.id
}

output "lakehouse_id" {
  description = "The id of the created lakehouse item."
  value       = module.lakehouse.id
}
