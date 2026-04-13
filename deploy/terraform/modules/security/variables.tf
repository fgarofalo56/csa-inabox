# =============================================================================
# Security Module — Variables
# Mirrors: deploy/bicep/shared/modules/security/cmkIdentity.bicep
# =============================================================================

variable "resource_group_name" {
  description = "Name of the resource group."
  type        = string
}

variable "location" {
  description = "Azure region for all resources."
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}

# --- CMK Identity ---

variable "cmk_identity_name" {
  description = "Name of the user-assigned managed identity for CMK operations."
  type        = string
  default     = ""
}

variable "deploy_cmk_identity" {
  description = "Deploy a user-assigned managed identity for CMK."
  type        = bool
  default     = false
}

# --- Key Vault Key ---

variable "deploy_cmk_key" {
  description = "Deploy a Key Vault key for CMK encryption."
  type        = bool
  default     = false
}

variable "key_vault_id" {
  description = "Resource ID of the Key Vault to create the CMK key in."
  type        = string
  default     = ""
}

variable "cmk_key_name" {
  description = "Name of the CMK encryption key."
  type        = string
  default     = "cmk-encryption-key"
}

variable "cmk_key_type" {
  description = "Key type (RSA, RSA-HSM, EC, EC-HSM)."
  type        = string
  default     = "RSA"
}

variable "cmk_key_size" {
  description = "Key size in bits."
  type        = number
  default     = 2048
}

variable "cmk_key_opts" {
  description = "Key operations."
  type        = list(string)
  default     = ["decrypt", "encrypt", "sign", "unwrapKey", "verify", "wrapKey"]
}

# --- RBAC Assignment ---

variable "assign_crypto_user_role" {
  description = "Assign Key Vault Crypto User role to the CMK identity."
  type        = bool
  default     = false
}
