package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/csa-loom/terraform-provider-loom/internal/client"
)

var (
	_ datasource.DataSource              = (*workspaceDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*workspaceDataSource)(nil)
)

// NewWorkspaceDataSource registers the `loom_workspace` data source.
func NewWorkspaceDataSource() datasource.DataSource { return &workspaceDataSource{} }

type workspaceDataSource struct {
	api *client.Client
}

type workspaceDataSourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Capacity    types.String `tfsdk:"capacity"`
	Domain      types.String `tfsdk:"domain"`
	ItemCount   types.Int64  `tfsdk:"item_count"`
}

func (d *workspaceDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_workspace"
}

func (d *workspaceDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Look up an existing Loom workspace by `id` or by `name` — the usual way to " +
			"attach `loom_item` resources to a workspace someone else created in the console.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "Workspace id. Supply either `id` or `name`.",
			},
			"name": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "Workspace display name. Supply either `id` or `name`.",
			},
			"description": schema.StringAttribute{Computed: true, MarkdownDescription: "Free-text description."},
			"capacity":    schema.StringAttribute{Computed: true, MarkdownDescription: "Capacity binding, when set."},
			"domain":      schema.StringAttribute{Computed: true, MarkdownDescription: "Governance domain id."},
			"item_count": schema.Int64Attribute{
				Computed:            true,
				MarkdownDescription: "Number of items in the workspace (best-effort, from `?count=true`).",
			},
		},
	}
}

func (d *workspaceDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	api, problem := apiFromProviderData(req.ProviderData)
	if problem != "" {
		resp.Diagnostics.AddError("Unexpected provider data", problem)
		return
	}
	d.api = api
}

func (d *workspaceDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config workspaceDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	wantID := config.ID.ValueString()
	wantName := config.Name.ValueString()
	if wantID == "" && wantName == "" {
		resp.Diagnostics.AddError(
			"Specify a workspace to look up",
			"Set either `id` or `name` on the `loom_workspace` data source.",
		)
		return
	}

	all, err := d.api.ListWorkspaces(ctx, true)
	if err != nil {
		resp.Diagnostics.AddError("Cannot list Loom workspaces", err.Error())
		return
	}

	matches := make([]client.Workspace, 0, 1)
	for _, ws := range all {
		if (wantID != "" && ws.ID == wantID) || (wantID == "" && wantName != "" && ws.Name == wantName) {
			matches = append(matches, ws)
		}
	}

	switch len(matches) {
	case 0:
		// Honest empty: never return a zero-valued workspace that looks real.
		resp.Diagnostics.AddError(
			"No matching Loom workspace",
			"No workspace visible to this token matches "+describeLookup(wantID, wantName)+
				". Check the id/name, or that the token's tenant can see it.",
		)
		return
	case 1:
		// fall through
	default:
		resp.Diagnostics.AddError(
			"Ambiguous Loom workspace lookup",
			describeLookup(wantID, wantName)+" matches more than one workspace; look it up by `id` instead.",
		)
		return
	}

	found := matches[0]
	itemCount := types.Int64Null()
	if found.ItemCount != nil {
		itemCount = types.Int64Value(*found.ItemCount)
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, workspaceDataSourceModel{
		ID:          types.StringValue(found.ID),
		Name:        types.StringValue(found.Name),
		Description: types.StringValue(found.Description),
		Capacity:    types.StringValue(found.Capacity),
		Domain:      types.StringValue(found.Domain),
		ItemCount:   itemCount,
	})...)
}

func describeLookup(id, name string) string {
	if id != "" {
		return "id " + id
	}
	return "name " + name
}
