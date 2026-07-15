output "id" {
  description = "The created workspace id."
  value       = restapi_object.workspace.id
}

output "api_response" {
  description = "The raw workspace object returned by the Loom API."
  value       = restapi_object.workspace.api_response
}
