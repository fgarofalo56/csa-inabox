# Working example: provision a Loom workspace + a lakehouse item via the API.
#
#   export TF_VAR_loom_token="loom_pat_<id>_<secret>"
#   terraform init
#   terraform apply -var "loom_api_url=https://<your-loom-host>"

terraform {
  required_version = ">= 1.3.0"

  required_providers {
    restapi = {
      source  = "Mastercard/restapi"
      version = ">= 1.18.0"
    }
  }
}

# Configure the REST provider to talk to THIS Loom deployment, authenticated
# with a scoped API token (a read-write PAT).
provider "restapi" {
  uri                  = var.loom_api_url
  write_returns_object = true
  id_attribute         = "id"

  headers = {
    Authorization = "Bearer ${var.loom_token}"
    Content-Type  = "application/json"
  }
}

module "workspace" {
  source = "../../modules/loom-workspace"

  name        = var.workspace_name
  description = "Provisioned by Terraform"
}

module "lakehouse" {
  source = "../../modules/loom-item"

  workspace_id = module.workspace.id
  item_type    = "lakehouse"
  display_name = var.lakehouse_name
  description  = "Bronze/Silver/Gold lakehouse, provisioned by Terraform"
}
