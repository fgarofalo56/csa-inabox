terraform {
  required_version = ">= 1.3.0"

  required_providers {
    restapi = {
      source  = "Mastercard/restapi"
      version = ">= 1.18.0"
    }
  }
}
