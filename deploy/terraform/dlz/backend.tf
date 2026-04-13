# =============================================================================
# DLZ — Backend Configuration (Azure Storage)
# =============================================================================

terraform {
  backend "azurerm" {
    # These values are typically provided via -backend-config or env vars:
    #   resource_group_name  = "rg-terraform-state"
    #   storage_account_name = "stterraformstate"
    #   container_name       = "tfstate"
    #   key                  = "csa-inabox/dlz/terraform.tfstate"
  }
}
