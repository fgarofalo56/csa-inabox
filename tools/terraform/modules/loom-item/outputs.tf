output "id" {
  description = "The created item id."
  value       = restapi_object.item.id
}

output "api_response" {
  description = "The raw item object returned by the Loom API."
  value       = restapi_object.item.api_response
}
