package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-log/tflog"

	"github.com/csa-loom/terraform-provider-loom/internal/client"
)

var (
	_ resource.Resource                = (*workspaceResource)(nil)
	_ resource.ResourceWithConfigure   = (*workspaceResource)(nil)
	_ resource.ResourceWithImportState = (*workspaceResource)(nil)
)

// NewWorkspaceResource registers `loom_workspace`.
func NewWorkspaceResource() resource.Resource { return &workspaceResource{} }

type workspaceResource struct {
	api *client.Client
}

type workspaceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Capacity    types.String `tfsdk:"capacity"`
	Domain      types.String `tfsdk:"domain"`
	CreatedAt   types.String `tfsdk:"created_at"`
	UpdatedAt   types.String `tfsdk:"updated_at"`
}

func (r *workspaceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_workspace"
}

func (r *workspaceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A CSA Loom workspace — the container for items.\n\n" +
			"**Lifecycle limitation (honest, not a stub):** the Loom public API documents " +
			"`GET`/`POST /api/workspaces` but no update or delete operation for a workspace. " +
			"Every configurable attribute is therefore `RequiresReplace`, and `terraform destroy` " +
			"removes the workspace from state while emitting a warning — the workspace itself must " +
			"be deleted in the Loom console. When the API grows those routes, this resource gains " +
			"them and the contract test in `internal/client` will flag the change.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Loom workspace id.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name of the workspace.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free-text description.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"capacity": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Optional capacity binding.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"domain": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "Governance domain id. Defaults to `default` server-side.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace(), stringplanmodifier.UseStateForUnknown()},
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

func (r *workspaceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	api, problem := apiFromProviderData(req.ProviderData)
	if problem != "" {
		resp.Diagnostics.AddError("Unexpected provider data", problem)
		return
	}
	r.api = api
}

func (r *workspaceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan workspaceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.api.CreateWorkspace(ctx, client.CreateWorkspaceRequest{
		Name:        plan.Name.ValueString(),
		Description: plan.Description.ValueString(),
		Capacity:    plan.Capacity.ValueString(),
		Domain:      plan.Domain.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Cannot create the Loom workspace", err.Error())
		return
	}

	tflog.Debug(ctx, "created loom workspace", map[string]any{"id": created.ID})
	resp.Diagnostics.Append(resp.State.Set(ctx, workspaceStateFrom(created, plan))...)
}

func (r *workspaceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state workspaceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	found, err := r.api.GetWorkspace(ctx, state.ID.ValueString())
	if client.IsNotFound(err) {
		// Deleted out of band — drop it so the next plan recreates it, rather
		// than reporting a healthy resource that no longer exists.
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the Loom workspace", err.Error())
		return
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, workspaceStateFrom(found, state))...)
}

func (r *workspaceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	// Every configurable attribute is RequiresReplace, so the framework should
	// never route an in-place update here. If it does, say so honestly instead
	// of silently writing an unchanged state.
	var plan workspaceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.AddError(
		"The Loom API has no workspace-update operation",
		"`loom_workspace` attributes are replace-only because the API documents no PATCH/PUT for a "+
			"workspace. Taint or replace the resource instead.",
	)
}

func (r *workspaceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state workspaceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.AddWarning(
		"Workspace removed from state but NOT deleted in Loom",
		"The Loom public API documents no workspace-delete operation, so workspace "+
			state.ID.ValueString()+" still exists in the deployment. Delete it in the Loom console "+
			"(Workspaces → … → Delete) if that was the intent.",
	)
}

func (r *workspaceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	found, err := r.api.GetWorkspace(ctx, req.ID)
	if err != nil {
		resp.Diagnostics.AddError("Cannot import the Loom workspace", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, workspaceStateFrom(found, workspaceModel{}))...)
}

// workspaceStateFrom maps an API workspace onto the Terraform model, keeping
// optional attributes null when the API omits them and the plan did not set
// them (so Terraform does not report perpetual drift on "" vs null).
func workspaceStateFrom(ws *client.Workspace, prior workspaceModel) workspaceModel {
	return workspaceModel{
		ID:          types.StringValue(ws.ID),
		Name:        types.StringValue(ws.Name),
		Description: optionalString(ws.Description, prior.Description),
		Capacity:    optionalString(ws.Capacity, prior.Capacity),
		Domain:      types.StringValue(firstNonEmpty(ws.Domain, prior.Domain.ValueString(), "default")),
		CreatedAt:   types.StringValue(ws.CreatedAt),
		UpdatedAt:   types.StringValue(ws.UpdatedAt),
	}
}

func optionalString(apiValue string, prior types.String) types.String {
	if apiValue != "" {
		return types.StringValue(apiValue)
	}
	if !prior.IsNull() && !prior.IsUnknown() && prior.ValueString() != "" {
		return prior
	}
	return types.StringNull()
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
