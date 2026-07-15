variable "name" {
  type        = string
  description = "Workspace display name."
}

variable "description" {
  type        = string
  description = "Optional workspace description."
  default     = null
}

variable "capacity" {
  type        = string
  description = "Optional capacity binding id."
  default     = null
}

variable "domain" {
  type        = string
  description = "Governance domain id the workspace binds to. Defaults to the tenant's 'default' starter domain when null."
  default     = null
}
