package provider

import (
	"context"
	"os"
	"testing"

	fwdatasource "github.com/hashicorp/terraform-plugin-framework/datasource"
	fwprovider "github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	fwresource "github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
)

// testAccProtoV6ProviderFactories wires the in-process provider into the
// acceptance-test harness, so `terraform apply` inside a test uses THIS build —
// not a registry download.
var testAccProtoV6ProviderFactories = map[string]func() (tfprotov6.ProviderServer, error){
	"loom": providerserver.NewProtocol6WithError(New("test")()),
}

// testAccPreCheck fails fast (rather than producing a confusing Terraform error)
// when the environment is not configured for a real apply.
//
// Acceptance tests are opt-in: they only run with TF_ACC=1 AND a reachable
// deployment. That keeps `go test ./...` in CI a pure unit/contract run while
// making the real end-to-end path a single command away for an operator with a
// minted token — the same posture as the console's UAT harness.
//
// License note: the harness shells out to a Terraform-compatible CLI. Point
// TF_ACC_TERRAFORM_PATH at `tofu` (OpenTofu, MPL-2.0) to keep the whole toolchain
// permissively licensed; the HashiCorp `terraform` CLI is BUSL-1.1 from 1.6.
func testAccPreCheck(t *testing.T) {
	t.Helper()
	if os.Getenv("LOOM_BASE_URL") == "" {
		t.Fatal("LOOM_BASE_URL must be set for acceptance tests (e.g. https://csa-loom.example.gov)")
	}
	if os.Getenv("LOOM_API_TOKEN") == "" {
		t.Fatal("LOOM_API_TOKEN must be set for acceptance tests (a read-write scoped PAT)")
	}
	if os.Getenv("TF_ACC_TERRAFORM_PATH") == "" {
		t.Log("TF_ACC_TERRAFORM_PATH is unset; the harness will look for `terraform` on PATH. " +
			"Set it to `tofu` to keep the toolchain MPL-2.0.")
	}
}

// skipUnlessAcceptance centralises the TF_ACC guard so every acceptance test
// reads the same way.
func skipUnlessAcceptance(t *testing.T) {
	t.Helper()
	if os.Getenv("TF_ACC") == "" {
		t.Skip("acceptance test skipped; set TF_ACC=1 plus LOOM_BASE_URL + LOOM_API_TOKEN to run it")
	}
}

// --------------------------------------------------------------------------- //
// Schema tests — no CLI, no network, so they run on every `go test ./...`.
// --------------------------------------------------------------------------- //

func TestProviderSchemaIsValid(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	p := New("test")()

	metaResp := &fwprovider.MetadataResponse{}
	p.Metadata(ctx, fwprovider.MetadataRequest{}, metaResp)
	if metaResp.TypeName != "loom" {
		t.Errorf("expected provider type name %q, got %q", "loom", metaResp.TypeName)
	}

	schemaResp := &fwprovider.SchemaResponse{}
	p.Schema(ctx, fwprovider.SchemaRequest{}, schemaResp)
	if schemaResp.Diagnostics.HasError() {
		t.Fatalf("provider schema has errors: %v", schemaResp.Diagnostics)
	}
	for _, want := range []string{"base_url", "token"} {
		if _, ok := schemaResp.Schema.Attributes[want]; !ok {
			t.Errorf("provider schema is missing the %q attribute", want)
		}
	}
	if !schemaResp.Schema.Attributes["token"].IsSensitive() {
		t.Error("the token attribute must be marked sensitive so it never lands in plan output")
	}
}

func TestResourceSchemasAreValid(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	cases := []struct {
		name       string
		factory    func() fwresource.Resource
		typeName   string
		attributes []string
	}{
		{
			name:       "loom_workspace",
			factory:    NewWorkspaceResource,
			typeName:   "loom_workspace",
			attributes: []string{"id", "name", "description", "capacity", "domain", "created_at", "updated_at"},
		},
		{
			name:     "loom_item",
			factory:  NewItemResource,
			typeName: "loom_item",
			attributes: []string{
				"id", "workspace_id", "item_type", "display_name", "description",
				"state_json", "created_at", "updated_at",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := tc.factory()

			metaResp := &fwresource.MetadataResponse{}
			r.Metadata(ctx, fwresource.MetadataRequest{ProviderTypeName: "loom"}, metaResp)
			if metaResp.TypeName != tc.typeName {
				t.Errorf("expected %q, got %q", tc.typeName, metaResp.TypeName)
			}

			schemaResp := &fwresource.SchemaResponse{}
			r.Schema(ctx, fwresource.SchemaRequest{}, schemaResp)
			if schemaResp.Diagnostics.HasError() {
				t.Fatalf("%s schema has errors: %v", tc.name, schemaResp.Diagnostics)
			}
			for _, attr := range tc.attributes {
				if _, ok := schemaResp.Schema.Attributes[attr]; !ok {
					t.Errorf("%s is missing the %q attribute", tc.name, attr)
				}
			}
			if schemaResp.Schema.MarkdownDescription == "" {
				t.Errorf("%s has no MarkdownDescription — registry docs would be empty", tc.name)
			}
		})
	}
}

func TestDataSourceSchemaIsValid(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	d := NewWorkspaceDataSource()

	metaResp := &fwdatasource.MetadataResponse{}
	d.Metadata(ctx, fwdatasource.MetadataRequest{ProviderTypeName: "loom"}, metaResp)
	if metaResp.TypeName != "loom_workspace" {
		t.Errorf("expected loom_workspace, got %q", metaResp.TypeName)
	}

	schemaResp := &fwdatasource.SchemaResponse{}
	d.Schema(ctx, fwdatasource.SchemaRequest{}, schemaResp)
	if schemaResp.Diagnostics.HasError() {
		t.Fatalf("data source schema has errors: %v", schemaResp.Diagnostics)
	}
	for _, attr := range []string{"id", "name", "description", "capacity", "domain", "item_count"} {
		if _, ok := schemaResp.Schema.Attributes[attr]; !ok {
			t.Errorf("loom_workspace data source is missing the %q attribute", attr)
		}
	}
}

func TestProviderRegistersEverySurface(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	p := New("test")()

	if got := len(p.Resources(ctx)); got != 2 {
		t.Errorf("expected 2 resources (workspace, item), got %d", got)
	}
	if got := len(p.DataSources(ctx)); got != 1 {
		t.Errorf("expected 1 data source (workspace), got %d", got)
	}
}

func TestProviderFactoriesAreWired(t *testing.T) {
	t.Parallel()
	factory, ok := testAccProtoV6ProviderFactories["loom"]
	if !ok {
		t.Fatal("the acceptance-test provider factory is not registered under \"loom\"")
	}
	server, err := factory()
	if err != nil {
		t.Fatalf("provider server factory failed: %v", err)
	}
	if server == nil {
		t.Fatal("provider server factory returned nil")
	}
}
