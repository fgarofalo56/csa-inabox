package provider

import (
	"fmt"
	"testing"
	"time"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// TestAccItemResource exercises the full CRUD path for `loom_item` against a
// live deployment: create → read → in-place update → import → destroy.
//
// The item type is `lakehouse`, which is Azure-native by default (ADLS Gen2 +
// Delta) — the suite deliberately does NOT require a Microsoft Fabric workspace.
//
// Opt-in:
//
//	TF_ACC=1 LOOM_BASE_URL=… LOOM_API_TOKEN=… TF_ACC_TERRAFORM_PATH=$(command -v tofu) \
//	go test ./internal/provider/ -run TestAccItemResource -v
func TestAccItemResource(t *testing.T) {
	skipUnlessAcceptance(t)

	suffix := time.Now().UnixNano()
	workspace := fmt.Sprintf("tfacc-ws-%d", suffix)
	item := fmt.Sprintf("tfacc-lakehouse-%d", suffix)

	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: testAccItemConfig(workspace, item, "bronze zone"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrSet("loom_item.test", "id"),
					resource.TestCheckResourceAttr("loom_item.test", "item_type", "lakehouse"),
					resource.TestCheckResourceAttr("loom_item.test", "display_name", item),
					resource.TestCheckResourceAttr("loom_item.test", "description", "bronze zone"),
					resource.TestCheckResourceAttrPair(
						"loom_item.test", "workspace_id",
						"loom_workspace.test", "id",
					),
				),
			},
			{
				// In-place update: description changes, id must NOT change.
				Config: testAccItemConfig(workspace, item, "curated bronze zone"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("loom_item.test", "description", "curated bronze zone"),
				),
			},
			// The API addresses items as {type}/{id}; the import id must match.
			{
				ResourceName:            "loom_item.test",
				ImportState:             true,
				ImportStateIdFunc:       importIDForItem("loom_item.test"),
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"state_json"},
			},
		},
	})
}

// importIDForItem builds the `<item_type>/<id>` import id from applied state.
func importIDForItem(resourceName string) resource.ImportStateIdFunc {
	return func(s *terraform.State) (string, error) {
		rs, ok := s.RootModule().Resources[resourceName]
		if !ok {
			return "", fmt.Errorf("resource %s not found in state", resourceName)
		}
		return rs.Primary.Attributes["item_type"] + "/" + rs.Primary.ID, nil
	}
}

func testAccItemConfig(workspace, item, description string) string {
	return fmt.Sprintf(`
resource "loom_workspace" "test" {
  name = %[1]q
}

resource "loom_item" "test" {
  workspace_id = loom_workspace.test.id
  item_type    = "lakehouse"
  display_name = %[2]q
  description  = %[3]q
}
`, workspace, item, description)
}
