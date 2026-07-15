variable "workspace_id" {
  type        = string
  description = "The workspace the item is created in."
}

variable "item_type" {
  type        = string
  description = "One of the ~120 Azure-native item types (e.g. lakehouse, notebook, warehouse). Run `loom item types` for the full list."
}

variable "display_name" {
  type        = string
  description = "Item display name."
}

variable "description" {
  type        = string
  description = "Optional item description."
  default     = null
}
