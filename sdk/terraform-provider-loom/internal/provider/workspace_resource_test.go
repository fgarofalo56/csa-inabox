package provider

import (
	"fmt"
	"testing"
	"time"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
)

// TestAccWorkspaceResource is the real end-to-end receipt for `loom_workspace`:
// it applies against a LIVE deployment, re-reads the workspace through the
// provider, and verifies the plan is empty afterwards (no perpetual drift).
//
// Opt-in:
//
//	TF_ACC=1 LOOM_BASE_URL=https://csa-loom.example.gov LOOM_API_TOKEN=loom_pat_… \
//	TF_ACC_TERRAFORM_PATH=$(command -v tofu) go test ./internal/provider/ -run TestAcc -v
//
// Note the documented lifecycle limitation: destroy removes the workspace from
// state with a warning because the API has no delete route. There is deliberately
// no CheckDestroy here — asserting the remote object is gone would be a false
// claim about behaviour the API does not provide.
func TestAccWorkspaceResource(t *testing.T) {
	skipUnlessAcceptance(t)

	name := fmt.Sprintf("tfacc-ws-%d", time.Now().UnixNano())

	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: testAccWorkspaceConfig(name, "created by the terraform-provider-loom acceptance suite"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrSet("loom_workspace.test", "id"),
					resource.TestCheckResourceAttr("loom_workspace.test", "name", name),
					resource.TestCheckResourceAttr(
						"loom_workspace.test",
						"description",
						"created by the terraform-provider-loom acceptance suite",
					),
					resource.TestCheckResourceAttrSet("loom_workspace.test", "domain"),
				),
			},
			{
				// The data source must resolve the workspace the resource just made.
				Config: testAccWorkspaceWithDataSourceConfig(name),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrPair(
						"data.loom_workspace.lookup", "id",
						"loom_workspace.test", "id",
					),
				),
			},
			// created_at/updated_at come back from the API on import, but a fresh
			// import has no prior plan for the optional capacity.
			{
				ResourceName:            "loom_workspace.test",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"capacity"},
			},
		},
	})
}

func testAccWorkspaceConfig(name, description string) string {
	return fmt.Sprintf(`
resource "loom_workspace" "test" {
  name        = %[1]q
  description = %[2]q
}
`, name, description)
}

func testAccWorkspaceWithDataSourceConfig(name string) string {
	return fmt.Sprintf(`
resource "loom_workspace" "test" {
  name        = %[1]q
  description = "created by the terraform-provider-loom acceptance suite"
}

data "loom_workspace" "lookup" {
  name = loom_workspace.test.name
}
`, name)
}
