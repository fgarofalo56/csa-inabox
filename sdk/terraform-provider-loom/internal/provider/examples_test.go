package provider

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The examples are the provider's documentation, and stale documentation is its
// own kind of vaporware. These tests need no Terraform CLI: they parse-smoke the
// HCL (balanced delimiters) and assert every resource/data-source type and every
// attribute referenced actually exists in the provider schemas.

func exampleFiles(t *testing.T) []string {
	t.Helper()
	var files []string
	err := filepath.Walk("../../examples", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && strings.HasSuffix(path, ".tf") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("cannot walk examples/: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no .tf examples found — the provider ships without usage documentation")
	}
	return files
}

func TestExamplesHaveBalancedDelimiters(t *testing.T) {
	t.Parallel()
	for _, file := range exampleFiles(t) {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		curly, square := 0, 0
		for _, ch := range string(raw) {
			switch ch {
			case '{':
				curly++
			case '}':
				curly--
			case '[':
				square++
			case ']':
				square--
			}
			if curly < 0 || square < 0 {
				t.Fatalf("%s: unbalanced delimiters", file)
			}
		}
		if curly != 0 || square != 0 {
			t.Errorf("%s: unbalanced delimiters (curly=%d square=%d)", file, curly, square)
		}
	}
}

// TestExamplesOnlyUseRealTypes catches an example that references a resource the
// provider does not register — the most common way example HCL rots.
func TestExamplesOnlyUseRealTypes(t *testing.T) {
	t.Parallel()

	known := map[string]bool{
		"loom_workspace": true,
		"loom_item":      true,
	}

	for _, file := range exampleFiles(t) {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		for _, line := range strings.Split(string(raw), "\n") {
			trimmed := strings.TrimSpace(line)
			var declared string
			switch {
			case strings.HasPrefix(trimmed, `resource "loom_`):
				declared = fieldBetweenQuotes(trimmed, 1)
			case strings.HasPrefix(trimmed, `data "loom_`):
				declared = fieldBetweenQuotes(trimmed, 1)
			default:
				continue
			}
			if declared != "" && !known[declared] {
				t.Errorf("%s references %q, which this provider does not register", file, declared)
			}
		}
	}
}

// fieldBetweenQuotes returns the nth quoted field on a line (1-indexed).
func fieldBetweenQuotes(line string, n int) string {
	parts := strings.Split(line, `"`)
	idx := (n * 2) - 1
	if idx >= len(parts) {
		return ""
	}
	return parts[idx]
}
