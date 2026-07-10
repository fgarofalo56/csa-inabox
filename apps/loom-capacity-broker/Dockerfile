# Loom Capacity Broker (HYP-9) — internal-ingress ACA service.
#
# Multi-stage, distroless static, non-root. ZERO external Go modules (the Redis
# client is a hand-rolled RESP2 client over the stdlib — internal/resp), so the
# build needs no module download and runs offline in `az acr build` / CI.
#
# Server-side build (no local Docker daemon required — same path as
# loom-script-runner / gh-aca-runner):
#   az acr build -r <acr> -t loom-capacity-broker:<tag> apps/loom-capacity-broker

FROM golang:1.23-alpine AS build
WORKDIR /src
# Copy the module and source (no go.sum — there are no external deps).
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
# Static, stripped binary. Vet + test run in CI separately; keep the image build lean.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/broker ./cmd/broker

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/broker /broker
# Internal ingress; the app reads PORT (default 8080).
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/broker"]
