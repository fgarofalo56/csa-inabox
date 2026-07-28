// Package client is the Loom API client the Terraform provider uses.
//
// Standard library only (net/http + encoding/json): the provider adds no HTTP
// dependency of its own, which keeps its license posture to the four MPL-2.0
// HashiCorp plugin SDKs and nothing else.
//
// Every route this package calls is declared in Endpoints (endpoints.go) and
// asserted against sdk/openapi.json by contract_test.go, so the provider cannot
// drift from the API contract any more than the Python SDK can.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultTimeout bounds every request. Terraform applies are long-lived; a
// hung HTTP call would otherwise wedge a plan indefinitely.
const DefaultTimeout = 60 * time.Second

// Client talks to one Loom deployment.
type Client struct {
	// BaseURL is the deployment origin, e.g. https://csa-loom.example.gov.
	// No cloud is hard-coded: Commercial and Government differ only here.
	BaseURL string
	// Token is a scoped Loom PAT (loom_pat_<id>_<secret>).
	Token string
	// UserAgent identifies the provider in Loom's access logs.
	UserAgent string
	// HTTP is the underlying transport; nil uses a bounded default.
	HTTP *http.Client
}

// New builds a client with a bounded default transport.
func New(baseURL, token, userAgent string) *Client {
	return &Client{
		BaseURL:   strings.TrimRight(baseURL, "/"),
		Token:     token,
		UserAgent: userAgent,
		HTTP:      &http.Client{Timeout: DefaultTimeout},
	}
}

// APIError is a non-2xx response from Loom, preserving the API's
// {ok:false, error, code?, hint?} envelope. Hint carries an honest infra gate's
// remediation text so a practitioner sees exactly what to configure.
type APIError struct {
	Status int
	Method string
	Path   string
	Msg    string
	Code   string
	Hint   string
}

func (e *APIError) Error() string {
	out := fmt.Sprintf("%s %s -> %d: %s", e.Method, e.Path, e.Status, e.Msg)
	if e.Code != "" {
		out += " [" + e.Code + "]"
	}
	if e.Hint != "" {
		out += "\n  hint: " + e.Hint
	}
	return out
}

// IsNotFound reports whether err is a 404 — the signal Terraform needs to drop a
// resource from state instead of failing the plan. It unwraps, so a caller that
// annotates the error with %w keeps the behaviour.
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

type errorEnvelope struct {
	Error string `json:"error"`
	Code  string `json:"code"`
	Hint  string `json:"hint"`
}

// do performs one request and decodes a 2xx body into out (which may be nil).
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	target := c.BaseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding request body for %s %s: %w", method, path, err)
		}
		payload = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, target, payload)
	if err != nil {
		return fmt.Errorf("building %s %s: %w", method, path, err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: DefaultTimeout}
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading %s %s response: %w", method, path, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		envelope := errorEnvelope{}
		_ = json.Unmarshal(raw, &envelope)
		msg := envelope.Error
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		if msg == "" {
			msg = resp.Status
		}
		return &APIError{
			Status: resp.StatusCode,
			Method: method,
			Path:   path,
			Msg:    truncate(msg, 500),
			Code:   envelope.Code,
			Hint:   envelope.Hint,
		}
	}

	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decoding %s %s response: %w", method, path, err)
	}
	return nil
}

// truncate bounds an error message without splitting a UTF-8 rune.
func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// segment percent-encodes one path segment so an id containing "/" or "?"
// cannot escape into a different route.
func segment(value string) string {
	return url.PathEscape(value)
}
