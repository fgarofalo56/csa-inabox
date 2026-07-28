// Command terraform-provider-loom serves the Loom Terraform provider.
//
// The provider manages Loom workspaces and items through the SAME public API
// the console serves (`/api/openapi.json`) — no Azure control-plane calls, no
// Microsoft Fabric dependency, and no cloud host baked in: the operator points
// `provider "loom" { base_url = … }` at their own Commercial or Government
// deployment.
//
// Build + run locally (this repository does NOT publish to the registry):
//
//	go build -o terraform-provider-loom .
//	# then point Terraform at it with a dev_overrides block — see README.md
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/csa-loom/terraform-provider-loom/internal/provider"
)

// version is stamped at build time: -ldflags "-X main.version=$(git describe --tags)".
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		// Namespaced under the operator's own registry host by convention; the
		// address is only meaningful to Terraform's provider resolution and is
		// overridden by dev_overrides during local development.
		Address: "registry.terraform.io/csa-loom/loom",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
