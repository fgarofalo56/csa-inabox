// Package ledger is the Loom Capacity Broker's timepoint ledger: a sliding
// 2,880 x 30-second (24 h) per-tenant/workspace LCU accumulator. Two backends
// share one interface:
//
//   - memory — an in-process map, the DEFAULT so the broker's core path EXECUTES
//     end-to-end with no external dependency (honest per no-vaporware.md).
//   - redis  — the cross-replica production backend, selected when LOOM_BROKER_REDIS
//     (alias LOOM_CAPACITY_BROKER_REDIS) is set. Real TCP/TLS RESP2 via internal/resp.
//
// Every response reports which backend served it (Backend()), so the caller can
// surface "in-memory (single-replica)" vs "redis (shared)" honestly.
package ledger

import (
	"context"
	"os"
	"strings"

	"loom-capacity-broker/internal/smoothing"
)

// Ledger accumulates smoothed LCU across 30-second timepoints and reads the
// future window back for the throttle decision.
type Ledger interface {
	// Backend names the active store ("memory" | "redis").
	Backend() string

	// AddSpread adds `perTimepoint` LCU to each of the N timepoints starting at
	// startTimepoint (the smoothing spread of one admitted job).
	AddSpread(ctx context.Context, key string, startTimepoint int64, perTimepoint float64, n int) error

	// Future returns the accumulated LCU for the `horizon` timepoints starting at
	// startTimepoint, index 0 == startTimepoint. Absent timepoints read as 0.
	Future(ctx context.Context, key string, startTimepoint int64, horizon int) ([]float64, error)

	// LastHourLcu sums the LCU committed to the 120 timepoints (1 h) ending at
	// startTimepoint — the FGC-25 per-workspace hourly-cap input.
	LastHourLcu(ctx context.Context, key string, startTimepoint int64) (float64, error)

	// Ping verifies the backend is reachable (health check). memory always ok.
	Ping(ctx context.Context) error

	// Close releases any resources.
	Close() error
}

// Key builds the ledger key for a tenant/workspace pair.
func Key(tenantID, workspaceID string) string {
	if workspaceID == "" {
		workspaceID = "_"
	}
	return "lcu:" + tenantID + ":" + workspaceID
}

// New returns a Ledger, selecting redis when a connection string is configured
// and otherwise the in-memory fallback. It returns the constructed ledger and
// never nil; a redis dial failure falls back to memory with the returned error
// surfaced for logging (the broker stays up — default-ON posture).
func New(ctx context.Context) (Ledger, error) {
	conn := firstNonEmpty(
		os.Getenv("LOOM_BROKER_REDIS"),
		os.Getenv("LOOM_CAPACITY_BROKER_REDIS"),
	)
	if strings.TrimSpace(conn) == "" {
		return NewMemory(), nil
	}
	rl, err := NewRedis(ctx, conn)
	if err != nil {
		// Honest fallback: broker keeps running on memory, error is logged upstream.
		return NewMemory(), err
	}
	return rl, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// hourTimepoints is the number of 30s timepoints in one hour (FGC-25 cap window).
const hourTimepoints = 3600 / smoothing.TimepointSeconds
