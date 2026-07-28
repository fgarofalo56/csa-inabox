package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-log/tflog"

	"github.com/csa-loom/terraform-provider-loom/internal/client"
)

var (
	_ resource.Resource                = (*itemResource)(nil)
	_ resource.ResourceWithConfigure   = (*itemResource)(nil)
	_ resource.ResourceWithImportState = (*itemResource)(nil)
)

// NewItemResource registers `loom_item`.
func NewItemResource() resource.Resource { return &itemResource{} }

type itemResource struct {
	api *client.Client
}

type itemModel struct {
	ID          types.String `tfsdk:"id"`
	WorkspaceID types.String `tfsdk:"workspace_id"`
	ItemType    types.String `tfsdk:"item_type"`
	DisplayName types.String `tfsdk:"display_name"`
	Description types.String `tfsdk:"description"`
	StateJSON   types.String `tfsdk:"state_json"`
	CreatedAt   types.String `tfsdk:"created_at"`
	UpdatedAt   types.String `tfsdk:"updated_at"`
}

func (r *itemResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_item"
}

func (r *itemResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Any of the Azure-native Loom item types (lakehouse, notebook, warehouse, " +
			"data-pipeline, …) inside a workspace. Every item type is Azure-backed by default — no " +
			"Microsoft Fabric tenant or workspace is required.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Loom item id.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"workspace_id": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Id of the workspace that owns the item.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"item_type": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Loom item type, e.g. `lakehouse`, `notebook`, `warehouse`, " +
					"`data-pipeline`. Run `loom item types` for the full list served by your deployment.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"display_name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name of the item.",
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free-text description.",
			},
			"state_json": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Per-item-type editor state, as a JSON object string — use " +
					"`jsonencode({...})`. Only supply this for item types whose state you intend to " +
					"manage as code; leaving it null lets the console own the editor state.",
			},
			"created_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "RFC 3339 creation timestamp reported by Loom.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"updated_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "RFC 3339 last-modified timestamp reported by Loom.",
			},
		},
	}
}

func (r *itemResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	api, problem := apiFromProviderData(req.ProviderData)
	if problem != "" {
		resp.Diagnostics.AddError("Unexpected provider data", problem)
		return
	}
	r.api = api
}

func (r *itemResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan itemModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.api.CreateItem(ctx, plan.WorkspaceID.ValueString(), client.CreateItemRequest{
		ItemType:    plan.ItemType.ValueString(),
		DisplayName: plan.DisplayName.ValueString(),
		Description: plan.Description.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Cannot create the Loom item", err.Error())
		return
	}
	tflog.Debug(ctx, "created loom item", map[string]any{"id": created.ID, "type": created.ItemType})

	// The create route accepts name/description only; editor state is a
	// follow-up PATCH so the resource still converges in one apply.
	if !plan.StateJSON.IsNull() && plan.StateJSON.ValueString() != "" {
		decoded, diagErr := decodeStateJSON(plan.StateJSON.ValueString())
		if diagErr != "" {
			resp.Diagnostics.AddAttributeError(path.Root("state_json"), "Invalid state_json", diagErr)
			return
		}
		updated, err := r.api.UpdateItem(ctx, created.ItemType, created.ID, client.UpdateItemRequest{State: decoded})
		if err != nil {
			resp.Diagnostics.AddError("Item created but its state could not be applied", err.Error())
			return
		}
		created = updated
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, itemStateFrom(created, plan))...)
}

func (r *itemResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state itemModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	found, err := r.api.GetItem(ctx, state.ItemType.ValueString(), state.ID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the Loom item", err.Error())
		return
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, itemStateFrom(found, state))...)
}

func (r *itemResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan itemModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state itemModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	patch := client.UpdateItemRequest{
		DisplayName: plan.DisplayName.ValueString(),
		Description: plan.Description.ValueString(),
	}
	if !plan.StateJSON.IsNull() && plan.StateJSON.ValueString() != "" {
		decoded, diagErr := decodeStateJSON(plan.StateJSON.ValueString())
		if diagErr != "" {
			resp.Diagnostics.AddAttributeError(path.Root("state_json"), "Invalid state_json", diagErr)
			return
		}
		patch.State = decoded
	}

	updated, err := r.api.UpdateItem(ctx, state.ItemType.ValueString(), state.ID.ValueString(), patch)
	if err != nil {
		resp.Diagnostics.AddError("Cannot update the Loom item", err.Error())
		return
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, itemStateFrom(updated, plan))...)
}

func (r *itemResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state itemModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.api.DeleteItem(ctx, state.ItemType.ValueString(), state.ID.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Cannot delete the Loom item", err.Error())
	}
}

// ImportState accepts `<item_type>/<id>`, matching the API's own route shape
// (`/api/cosmos-items/{type}/{id}`) — an item id alone is not addressable.
func (r *itemResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := strings.SplitN(req.ID, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		resp.Diagnostics.AddError(
			"Invalid import id",
			fmt.Sprintf("expected `<item_type>/<id>` (e.g. lakehouse/abc123), got %q", req.ID),
		)
		return
	}

	found, err := r.api.GetItem(ctx, parts[0], parts[1])
	if err != nil {
		resp.Diagnostics.AddError("Cannot import the Loom item", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, itemStateFrom(found, itemModel{}))...)
}

// decodeStateJSON validates state_json is a JSON OBJECT (the API's `state` is an
// object, not an array or scalar) and returns the decoded map.
func decodeStateJSON(raw string) (map[string]any, string) {
	decoded := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, "state_json must be a JSON object (use jsonencode({...})): " + err.Error()
	}
	return decoded, ""
}

func itemStateFrom(item *client.Item, prior itemModel) itemModel {
	stateJSON := prior.StateJSON
	if len(item.State) > 0 {
		if encoded, err := json.Marshal(item.State); err == nil {
			// Only track state_json when the practitioner manages it; otherwise
			// echoing the console's own editor state would produce permanent drift.
			if !prior.StateJSON.IsNull() && prior.StateJSON.ValueString() != "" {
				stateJSON = types.StringValue(string(encoded))
			}
		}
	}

	return itemModel{
		ID:          types.StringValue(item.ID),
		WorkspaceID: types.StringValue(firstNonEmpty(item.WorkspaceID, prior.WorkspaceID.ValueString())),
		ItemType:    types.StringValue(item.ItemType),
		DisplayName: types.StringValue(item.DisplayName),
		Description: optionalString(item.Description, prior.Description),
		StateJSON:   stateJSON,
		CreatedAt:   types.StringValue(item.CreatedAt),
		UpdatedAt:   types.StringValue(item.UpdatedAt),
	}
}
