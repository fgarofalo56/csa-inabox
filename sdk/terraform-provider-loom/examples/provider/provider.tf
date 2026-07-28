terraform {
  required_providers {
    loom = {
      source = "csa-loom/loom"
    }
  }
}

# No cloud is baked into the provider: the same configuration targets a
# Commercial or a Government deployment by changing base_url alone.
provider "loom" {
  # Or export LOOM_BASE_URL / LOOM_API_TOKEN and omit both arguments.
  base_url = var.loom_base_url
  token    = var.loom_api_token
}

variable "loom_base_url" {
  type        = string
  description = "Origin of the Loom deployment, e.g. https://csa-loom.example.gov"
}

variable "loom_api_token" {
  type        = string
  sensitive   = true
  description = "A read-write scoped Loom API token (loom_pat_<id>_<secret>)"
}
