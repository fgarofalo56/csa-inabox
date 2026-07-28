# terraform-provider-loom — build + verify targets.
#
# Nothing here publishes. `make release` deliberately does not exist: B-N19b is
# packaging + CI only, and the registry publish is a separate operator decision.

BINARY   := terraform-provider-loom
VERSION  ?= dev
LDFLAGS  := -X main.version=$(VERSION)

.PHONY: help deps build test vet fmt fmtcheck contract testacc clean

help:
	@echo "deps      - go mod tidy (resolves the plugin SDKs and writes go.sum)"
	@echo "build     - compile the provider binary"
	@echo "vet       - go vet ./..."
	@echo "fmtcheck  - fail if any file is not gofmt'd"
	@echo "test      - unit + contract tests (no network, no Terraform CLI)"
	@echo "contract  - just the drift gate against ../openapi.json"
	@echo "testacc   - acceptance tests (needs TF_ACC=1, LOOM_BASE_URL, LOOM_API_TOKEN)"

deps:
	go mod tidy

build: deps
	go build -ldflags "$(LDFLAGS)" -o $(BINARY) .

vet:
	go vet ./...

fmt:
	gofmt -w .

fmtcheck:
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needed on:"; echo "$$unformatted"; exit 1; \
	fi

test:
	go test ./... -count=1

contract:
	go test ./internal/client/ -run 'TestEndpoints|TestSnapshot|TestPathParameters' -v -count=1

# Acceptance tests hit a REAL deployment. Point TF_ACC_TERRAFORM_PATH at `tofu`
# (OpenTofu, MPL-2.0) to keep the toolchain permissively licensed — the
# HashiCorp terraform CLI is BUSL-1.1 from 1.6 onward.
testacc:
	TF_ACC=1 go test ./internal/provider/ -run 'TestAcc' -v -count=1 -timeout 30m

clean:
	rm -f $(BINARY)
