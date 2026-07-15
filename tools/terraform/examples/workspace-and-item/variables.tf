variable "loom_api_url" {
  type        = string
  description = "Base URL of the Loom deployment, e.g. https://csa-loom.limitlessdata.ai"
}

variable "loom_token" {
  type        = string
  sensitive   = true
  description = "A read-write Loom API token (loom_pat_<id>_<secret>). Set via TF_VAR_loom_token."
}

variable "workspace_name" {
  type        = string
  description = "Name for the workspace to create."
  default     = "tf-provisioned-workspace"
}

variable "lakehouse_name" {
  type        = string
  description = "Name for the lakehouse item to create."
  default     = "tf-lakehouse"
}
