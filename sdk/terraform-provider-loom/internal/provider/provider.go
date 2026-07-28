// Package provider implements the Loom Terraform provider on
// terraform-plugin-framework.
//
// Scope note (no-vaporware): the provider covers exactly what the Loom public
// API documents — workspaces and items. Where the API has no operation for a
// lifecycle step (there is no workspace-delete route today), the provider says
// so explicitly in a diagnostic instead of pretending the call succeeded.
package provider

import (
	"context"
	"os"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/csa-loom/terraform-provider-loom/internal/client"
)

// Environment variables the provider falls back to when the block omits them.
// The base URL has NO default: hard-coding a Commercial host would silently
// make every Government plan wrong.
const (
	envBaseURL = "LOOM_BASE_URL"
	envToken   = "LOOM_API_TOKEN" //nolint:gosec // an env var name, not a credential
)

var _ provider.Provider = (*loomProvider)(nil)

type loomProvider struct {
	version string
}

// New returns the provider factory providerserver.Serve expects.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &loomProvider{version: version}
	}
}

type providerModel struct {
	BaseURL types.String `tfsdk:"base_url"`
	Token   types.String `tfsdk:"token"`
}

func (p *loomProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "loom"
	resp.Version = p.version
}

func (p *loomProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages CSA Loom workspaces and items through the Loom public API " +
			"(`/api/openapi.json`). The provider is cloud-agnostic: point `base_url` at a Commercial " +
			"or a Government deployment — nothing else changes.",
		Attributes: map[string]schema.Attribute{
			"base_url": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Origin of the Loom deployment, e.g. `https://csa-loom.example.gov`. " +
					"Defaults to the `LOOM_BASE_URL` environment variable. There is no built-in default host.",
			},
			"token": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "A scoped Loom API token (`loom_pat_<id>_<secret>`) created under " +
					"Settings → Developer → API tokens. Defaults to the `LOOM_API_TOKEN` environment " +
					"variable. A `read-write` scope is required to create or modify resources.",
			},
		},
	}
}

func (p *loomProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var config providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if config.BaseURL.IsUnknown() {
		resp.Diagnostics.AddAttributeError(
			path.Root("base_url"),
			"Loom base_url is not known at plan time",
			"Set base_url to a literal or an already-applied value, or export "+envBaseURL+".",
		)
	}
	if resp.Diagnostics.HasError() {
		return
	}

	baseURL := strings.TrimSpace(config.BaseURL.ValueString())
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv(envBaseURL))
	}
	token := config.Token.ValueString()
	if token == "" {
		token = os.Getenv(envToken)
	}

	if baseURL == "" {
		resp.Diagnostics.AddAttributeError(
			path.Root("base_url"),
			"Missing Loom base URL",
			"Set `base_url` in the provider block or export "+envBaseURL+
				" (for example https://csa-loom.example.gov). The provider deliberately has no default host so "+
				"the same configuration works against a Government deployment.",
		)
	}
	if token == "" {
		resp.Diagnostics.AddAttributeError(
			path.Root("token"),
			"Missing Loom API token",
			"Set `token` in the provider block or export "+envToken+
				". Create one under Settings → Developer → API tokens with the `read-write` scope.",
		)
	}
	if resp.Diagnostics.HasError() {
		return
	}

	api := client.New(baseURL, token, "terraform-provider-loom/"+p.version)

	// Fail fast, with the API's own words: a bad token surfaces here rather
	// than halfway through an apply.
	who, err := api.WhoAmI(ctx)
	if err != nil {
		resp.Diagnostics.AddError(
			"Cannot authenticate against the Loom API",
			"The credential probe `GET /api/v1/whoami` failed against "+baseURL+".\n\n"+err.Error(),
		)
		return
	}
	if who.Scope == "read-only" {
		resp.Diagnostics.AddWarning(
			"Loom token is read-only",
			"The configured token has the `read-only` scope, so data sources will work but every resource "+
				"create/update/delete will be refused with HTTP 403. Issue a `read-write` token to manage resources.",
		)
	}

	resp.DataSourceData = api
	resp.ResourceData = api
}

func (p *loomProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewWorkspaceResource,
		NewItemResource,
	}
}

func (p *loomProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewWorkspaceDataSource,
	}
}

// apiFromProviderData is the shared plumbing every resource/data source uses to
// pick the configured client out of the framework's ProviderData.
func apiFromProviderData(providerData any) (*client.Client, string) {
	if providerData == nil {
		return nil, ""
	}
	api, ok := providerData.(*client.Client)
	if !ok {
		return nil, "expected *client.Client from the provider, got a different type — this is a bug in the provider"
	}
	return api, ""
}
