module github.com/csa-loom/terraform-provider-loom

go 1.22

// The provider plugin SDKs. All four are HashiCorp's own, MPL-2.0 licensed, and
// are the ONLY way to speak Terraform's plugin protocol — see
// ../../THIRD_PARTY_LICENSES.md for the license disposition. Nothing here is
// baked into a Loom container image: the provider is a developer artifact built
// from source, and this repository does not publish it to any registry.
//
// go.sum is intentionally not committed: `make deps` / the sdk-contract CI lane
// runs `go mod tidy`, which resolves and pins the transitive set. See README.md
// ("Building") for the rationale and how to vendor for an air-gapped build.
require (
	github.com/hashicorp/terraform-plugin-framework v1.13.0
	github.com/hashicorp/terraform-plugin-go v0.25.0
	github.com/hashicorp/terraform-plugin-log v0.9.0
	github.com/hashicorp/terraform-plugin-testing v1.11.0
)
