package client

// Endpoints is the complete set of API routes this provider calls, expressed the
// same way the OpenAPI document expresses them (verb + templated path +
// operationId).
//
// It is not documentation: contract_test.go loads sdk/openapi.json and asserts
// every row still exists in the document with the same verb and path
// parameters. Adding a call to a route that is not declared here — or keeping a
// row for a route the API removed — fails `go test ./internal/client/...`.
//
// This is the Go-side half of the B-N19b drift gate; the Python SDK's
// tests/test_contract.py is the other half, and both read the same snapshot.
var Endpoints = []Endpoint{
	{OperationID: "whoami", Method: "GET", Path: "/api/v1/whoami"},
	{OperationID: "listWorkspaces", Method: "GET", Path: "/api/workspaces"},
	{OperationID: "createWorkspace", Method: "POST", Path: "/api/workspaces"},
	{OperationID: "listItems", Method: "GET", Path: "/api/workspaces/{workspaceId}/items"},
	{OperationID: "createItem", Method: "POST", Path: "/api/workspaces/{workspaceId}/items"},
	{OperationID: "getItem", Method: "GET", Path: "/api/cosmos-items/{type}/{id}"},
	{OperationID: "updateItem", Method: "PATCH", Path: "/api/cosmos-items/{type}/{id}"},
	{OperationID: "deleteItem", Method: "DELETE", Path: "/api/cosmos-items/{type}/{id}"},
}

// Endpoint is one route the provider depends on.
type Endpoint struct {
	// OperationID matches the OpenAPI document's operationId exactly.
	OperationID string
	// Method is the uppercase HTTP verb.
	Method string
	// Path is the templated OpenAPI path, e.g. /api/cosmos-items/{type}/{id}.
	Path string
}
