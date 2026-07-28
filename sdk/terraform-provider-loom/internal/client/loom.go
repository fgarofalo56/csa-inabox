package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// Workspace mirrors components.schemas.Workspace.
type Workspace struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Capacity    string `json:"capacity,omitempty"`
	Domain      string `json:"domain,omitempty"`
	CreatedBy   string `json:"createdBy,omitempty"`
	CreatedAt   string `json:"createdAt,omitempty"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
	ItemCount   *int64 `json:"itemCount,omitempty"`
}

// CreateWorkspaceRequest mirrors components.schemas.CreateWorkspace.
type CreateWorkspaceRequest struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Capacity    string `json:"capacity,omitempty"`
	Domain      string `json:"domain,omitempty"`
}

// Item mirrors components.schemas.Item.
type Item struct {
	ID          string         `json:"id"`
	WorkspaceID string         `json:"workspaceId"`
	ItemType    string         `json:"itemType"`
	DisplayName string         `json:"displayName"`
	Description string         `json:"description,omitempty"`
	State       map[string]any `json:"state,omitempty"`
	CreatedAt   string         `json:"createdAt,omitempty"`
	UpdatedAt   string         `json:"updatedAt,omitempty"`
}

// CreateItemRequest mirrors components.schemas.CreateItem.
type CreateItemRequest struct {
	ItemType    string `json:"itemType"`
	DisplayName string `json:"displayName"`
	Description string `json:"description,omitempty"`
}

// UpdateItemRequest mirrors components.schemas.UpdateItem.
type UpdateItemRequest struct {
	DisplayName string         `json:"displayName,omitempty"`
	Description string         `json:"description,omitempty"`
	State       map[string]any `json:"state,omitempty"`
}

// WhoAmI mirrors components.schemas.WhoAmI — the provider's Configure-time
// credential probe (operationId whoami).
type WhoAmI struct {
	OK       bool   `json:"ok"`
	Auth     string `json:"auth"`
	OID      string `json:"oid"`
	UPN      string `json:"upn"`
	Name     string `json:"name"`
	TenantID string `json:"tenantId"`
	Scope    string `json:"scope"`
	TokenID  string `json:"tokenId"`
}

// WhoAmI verifies the configured credential and reports its scope.
// GET /api/v1/whoami
func (c *Client) WhoAmI(ctx context.Context) (*WhoAmI, error) {
	out := &WhoAmI{}
	if err := c.do(ctx, http.MethodGet, "/api/v1/whoami", nil, nil, out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListWorkspaces returns every workspace visible to the credential.
// GET /api/workspaces
func (c *Client) ListWorkspaces(ctx context.Context, withCounts bool) ([]Workspace, error) {
	query := url.Values{}
	if withCounts {
		query.Set("count", "true")
	}
	out := []Workspace{}
	if err := c.do(ctx, http.MethodGet, "/api/workspaces", query, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetWorkspace resolves one workspace by id.
//
// The API has no GET /api/workspaces/{id}: the documented read path is the list
// route (operationId listWorkspaces), so the provider filters client-side rather
// than inventing an endpoint that does not exist.
func (c *Client) GetWorkspace(ctx context.Context, id string) (*Workspace, error) {
	all, err := c.ListWorkspaces(ctx, false)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, &APIError{
		Status: http.StatusNotFound,
		Method: http.MethodGet,
		Path:   "/api/workspaces",
		Msg:    fmt.Sprintf("workspace %q is not visible to this credential", id),
	}
}

// CreateWorkspace creates a workspace.
// POST /api/workspaces
func (c *Client) CreateWorkspace(ctx context.Context, req CreateWorkspaceRequest) (*Workspace, error) {
	out := &Workspace{}
	if err := c.do(ctx, http.MethodPost, "/api/workspaces", nil, req, out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListItems returns the items in a workspace.
// GET /api/workspaces/{workspaceId}/items
func (c *Client) ListItems(ctx context.Context, workspaceID string) ([]Item, error) {
	out := []Item{}
	path := "/api/workspaces/" + segment(workspaceID) + "/items"
	if err := c.do(ctx, http.MethodGet, path, nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateItem creates an item inside a workspace.
// POST /api/workspaces/{workspaceId}/items
func (c *Client) CreateItem(ctx context.Context, workspaceID string, req CreateItemRequest) (*Item, error) {
	out := &Item{}
	path := "/api/workspaces/" + segment(workspaceID) + "/items"
	if err := c.do(ctx, http.MethodPost, path, nil, req, out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetItem reads one item by type + id.
// GET /api/cosmos-items/{type}/{id}
func (c *Client) GetItem(ctx context.Context, itemType, id string) (*Item, error) {
	out := &Item{}
	path := "/api/cosmos-items/" + segment(itemType) + "/" + segment(id)
	if err := c.do(ctx, http.MethodGet, path, nil, nil, out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateItem patches an item's name / description / state.
// PATCH /api/cosmos-items/{type}/{id}
func (c *Client) UpdateItem(ctx context.Context, itemType, id string, req UpdateItemRequest) (*Item, error) {
	out := &Item{}
	path := "/api/cosmos-items/" + segment(itemType) + "/" + segment(id)
	if err := c.do(ctx, http.MethodPatch, path, nil, req, out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteItem deletes an item.
// DELETE /api/cosmos-items/{type}/{id}
func (c *Client) DeleteItem(ctx context.Context, itemType, id string) error {
	path := "/api/cosmos-items/" + segment(itemType) + "/" + segment(id)
	return c.do(ctx, http.MethodDelete, path, nil, nil, nil)
}
