package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// specPath resolves sdk/openapi.json — the SAME snapshot the Python SDK is
// generated from — relative to this package.
func specPath(t *testing.T) string {
	t.Helper()
	// internal/client -> internal -> terraform-provider-loom -> sdk
	return filepath.Join("..", "..", "..", "openapi.json")
}

type specParameter struct {
	Name string `json:"name"`
	In   string `json:"in"`
}

type specInfo struct {
	Title   string `json:"title"`
	Version string `json:"version"`
}

type specServer struct {
	URL string `json:"url"`
}

type openAPIDoc struct {
	OpenAPI string                                `json:"openapi"`
	Info    specInfo                              `json:"info"`
	Servers []specServer                          `json:"servers"`
	Paths   map[string]map[string]json.RawMessage `json:"paths"`
}

type operation struct {
	OperationID string          `json:"operationId"`
	Parameters  []specParameter `json:"parameters"`
}

type pathParameters struct {
	Parameters []specParameter `json:"parameters"`
}

func loadSpec(t *testing.T) openAPIDoc {
	t.Helper()
	raw, err := os.ReadFile(specPath(t))
	if err != nil {
		t.Fatalf("cannot read sdk/openapi.json (%v).\nRun: node sdk/scripts/dump-openapi.mjs", err)
	}
	doc := openAPIDoc{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("sdk/openapi.json is not valid JSON: %v", err)
	}
	return doc
}

// documentOperations flattens the document into operationId -> (method, path).
func documentOperations(t *testing.T, doc openAPIDoc) map[string]Endpoint {
	t.Helper()
	verbs := []string{"get", "post", "put", "patch", "delete", "head", "options"}
	found := map[string]Endpoint{}
	for path, item := range doc.Paths {
		for _, verb := range verbs {
			raw, ok := item[verb]
			if !ok {
				continue
			}
			op := operation{}
			if err := json.Unmarshal(raw, &op); err != nil || op.OperationID == "" {
				continue
			}
			found[op.OperationID] = Endpoint{
				OperationID: op.OperationID,
				Method:      strings.ToUpper(verb),
				Path:        path,
			}
		}
	}
	return found
}

// TestEndpointsExistInTheContract is the provider-side drift gate: every route
// the provider calls must still exist in the API document, with the same verb.
func TestEndpointsExistInTheContract(t *testing.T) {
	doc := loadSpec(t)
	document := documentOperations(t, doc)

	for _, want := range Endpoints {
		got, ok := document[want.OperationID]
		if !ok {
			t.Errorf("operation %q is no longer served by the API (declared in endpoints.go).\n"+
				"Fix: node sdk/scripts/dump-openapi.mjs, then update internal/client/endpoints.go",
				want.OperationID)
			continue
		}
		if got.Method != want.Method {
			t.Errorf("operation %q: provider calls %s, the API documents %s",
				want.OperationID, want.Method, got.Method)
		}
		if got.Path != want.Path {
			t.Errorf("operation %q: provider targets %s, the API documents %s",
				want.OperationID, want.Path, got.Path)
		}
	}
}

// TestPathParametersAreSubstituted proves each declared templated path is
// actually built by the client (no unresolved {placeholder} can reach the wire).
func TestPathParametersAreSubstituted(t *testing.T) {
	doc := loadSpec(t)
	for path, item := range doc.Paths {
		if !strings.Contains(path, "{") {
			continue
		}
		shared := pathParameters{}
		if raw, ok := item["parameters"]; ok {
			if err := json.Unmarshal(raw, &shared.Parameters); err != nil {
				t.Fatalf("%s: cannot decode shared parameters: %v", path, err)
			}
		}
		for _, param := range shared.Parameters {
			if param.In != "path" {
				continue
			}
			if !strings.Contains(path, "{"+param.Name+"}") {
				t.Errorf("%s declares path parameter %q that does not appear in the template", path, param.Name)
			}
		}
	}
}

// TestSnapshotIsDeploymentIndependent guards the same defect the console's
// cloud-endpoint-literal ratchet guards: a Commercial host dumped into the
// snapshot would silently make the provider wrong for a Government estate.
func TestSnapshotIsDeploymentIndependent(t *testing.T) {
	doc := loadSpec(t)
	if len(doc.Servers) == 0 {
		t.Fatal("sdk/openapi.json has no servers entry")
	}
	if doc.Servers[0].URL != "/" {
		t.Errorf("expected the relative server entry %q, got %q — re-dump with node sdk/scripts/dump-openapi.mjs",
			"/", doc.Servers[0].URL)
	}
	if !strings.HasPrefix(doc.OpenAPI, "3.1") {
		t.Errorf("expected an OpenAPI 3.1 document, got %q", doc.OpenAPI)
	}
	if doc.Info.Title == "" || doc.Info.Version == "" {
		t.Error("the document must carry info.title and info.version")
	}
}

// TestEveryEndpointIsUnique catches a copy-paste row in endpoints.go.
func TestEveryEndpointIsUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, e := range Endpoints {
		if seen[e.OperationID] {
			t.Errorf("duplicate endpoint row for %q", e.OperationID)
		}
		seen[e.OperationID] = true
	}
}
