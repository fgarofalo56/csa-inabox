terraform {
  required_version = ">= 1.3.0"

  required_providers {
    # Community full-CRUD REST provider. The Loom API is the console BFF; this
    # module drives it directly. A first-party terraform-provider-loom is on the
    # roadmap (see tools/terraform/README.md).
    restapi = {
      source  = "Mastercard/restapi"
      version = ">= 1.18.0"
    }
  }
}
