package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newTestServer spins a real httptest server so these tests exercise the actual
// net/http request path — URL building, headers, JSON encoding, status mapping —
// rather than a mocked-out client.
func newTestServer(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New(srv.URL, "loom_pat_test_secret", "terraform-provider-loom/test"), srv
}

func TestCreateWorkspaceSendsTheDocumentedRequest(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotContentType string
	var gotBody CreateWorkspaceRequest

	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(Workspace{ID: "w1", Name: gotBody.Name, Domain: gotBody.Domain})
	})

	ws, err := c.CreateWorkspace(context.Background(), CreateWorkspaceRequest{Name: "analytics", Domain: "default"})
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/workspaces" {
		t.Errorf("expected POST /api/workspaces, got %s %s", gotMethod, gotPath)
	}
	if gotAuth != "Bearer loom_pat_test_secret" {
		t.Errorf("bearer token not sent, got %q", gotAuth)
	}
	if gotContentType != "application/json" {
		t.Errorf("expected application/json content type, got %q", gotContentType)
	}
	if gotBody.Name != "analytics" || gotBody.Domain != "default" {
		t.Errorf("unexpected request body: %+v", gotBody)
	}
	if ws.ID != "w1" {
		t.Errorf("expected the created workspace id, got %q", ws.ID)
	}
}

func TestGetItemBuildsTheTemplatedPath(t *testing.T) {
	var gotPath string
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode(Item{ID: "i1", WorkspaceID: "w1", ItemType: "lakehouse", DisplayName: "bronze"})
	})

	item, err := c.GetItem(context.Background(), "lakehouse", "i1")
	if err != nil {
		t.Fatalf("GetItem: %v", err)
	}
	if gotPath != "/api/cosmos-items/lakehouse/i1" {
		t.Errorf("unexpected path %q", gotPath)
	}
	if item.DisplayName != "bronze" {
		t.Errorf("unexpected item %+v", item)
	}
}

func TestPathSegmentsArePercentEncoded(t *testing.T) {
	var gotPath string
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode(Item{ID: "a/b"})
	})

	if _, err := c.GetItem(context.Background(), "lakehouse", "a/b"); err != nil {
		t.Fatalf("GetItem: %v", err)
	}
	if gotPath != "/api/cosmos-items/lakehouse/a%2Fb" {
		t.Errorf("id was not percent-encoded; got %q", gotPath)
	}
}

func TestListWorkspacesCountQuery(t *testing.T) {
	var gotQuery string
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode([]Workspace{{ID: "w1", Name: "analytics"}})
	})

	if _, err := c.ListWorkspaces(context.Background(), true); err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if gotQuery != "count=true" {
		t.Errorf("expected count=true, got %q", gotQuery)
	}
}

func TestGetWorkspaceReturnsNotFoundWhenAbsent(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]Workspace{{ID: "other", Name: "other"}})
	})

	_, err := c.GetWorkspace(context.Background(), "missing")
	if err == nil {
		t.Fatal("expected an error for a workspace that is not visible")
	}
	if !IsNotFound(err) {
		t.Errorf("expected a 404-shaped error so Terraform drops it from state, got %v", err)
	}
}

func TestErrorEnvelopeIsPreserved(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"ok":false,"error":"Synapse pool not provisioned","code":"E_POOL","hint":"set LOOM_SYNAPSE_POOL"}`))
	})

	_, err := c.GetItem(context.Background(), "warehouse", "i1")
	if err == nil {
		t.Fatal("expected an error")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.Status != http.StatusServiceUnavailable {
		t.Errorf("unexpected status %d", apiErr.Status)
	}
	if apiErr.Msg != "Synapse pool not provisioned" || apiErr.Code != "E_POOL" {
		t.Errorf("envelope not preserved: %+v", apiErr)
	}
	if apiErr.Hint != "set LOOM_SYNAPSE_POOL" {
		t.Errorf("the honest-gate hint must survive to the practitioner, got %q", apiErr.Hint)
	}
}

func TestNotFoundIsDetectable(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"ok":false,"error":"no such item"}`))
	})

	err := c.DeleteItem(context.Background(), "lakehouse", "gone")
	if !IsNotFound(err) {
		t.Errorf("expected IsNotFound to be true, got %v", err)
	}
}

func TestNonJSONErrorBodyStillYieldsAMessage(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>bad gateway</html>"))
	})

	_, err := c.ListWorkspaces(context.Background(), false)
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.Msg == "" {
		t.Error("a non-JSON error body must still produce a message")
	}
}

func TestBaseURLTrailingSlashIsNormalised(t *testing.T) {
	c := New("https://loom.example.gov/", "t", "ua")
	if c.BaseURL != "https://loom.example.gov" {
		t.Errorf("trailing slash not trimmed: %q", c.BaseURL)
	}
}

func TestUserAgentIsSent(t *testing.T) {
	var gotUA string
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		_ = json.NewEncoder(w).Encode(WhoAmI{OK: true, Auth: "pat", Scope: "read-write"})
	})

	if _, err := c.WhoAmI(context.Background()); err != nil {
		t.Fatalf("WhoAmI: %v", err)
	}
	if gotUA != "terraform-provider-loom/test" {
		t.Errorf("unexpected user agent %q", gotUA)
	}
}
