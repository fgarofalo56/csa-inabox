module loom-capacity-broker

// Go 1.23. ZERO external dependencies by design: the Redis client is a small
// hand-rolled RESP2 client over crypto/tls + net (internal/resp), so `go build`
// and `go test ./...` need no module download and run fully offline in CI /
// `az acr build`. This keeps the /admit hot path free of a heavyweight driver
// and the image tiny (distroless static).
go 1.23
