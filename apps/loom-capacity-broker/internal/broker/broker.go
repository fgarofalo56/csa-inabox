// Package broker composes the pure smoothing math (internal/smoothing) with the
// timepoint ledger (internal/ledger) and the per-workspace policy into a single
// admission decision — the /admit choke-point's core. Everything here EXECUTES
// end-to-end at skeleton stage against whichever ledger backend is active
// (memory by default, redis when configured).
package broker

import (
	"context"
	"encoding/json"
	"time"

	"loom-capacity-broker/internal/ledger"
	"loom-capacity-broker/internal/smoothing"
)

// Policy is the per-workspace admission policy — the FGC-25 surge-protection
// knobs (surge-protection-panel.tsx) promoted to the broker's control layer.
type Policy struct {
	// Enabled — when false the broker meters but never throttles (default-ON
	// posture: it constrains, it never blocks the platform).
	Enabled bool `json:"enabled"`
	// CapacityCu is the steady-state capacity (F-SKU-equivalent CU) the smoothing
	// math sizes per-timepoint capacity from. 0 → DefaultCapacityCu (F2).
	CapacityCu float64 `json:"capacityCu"`
	// WorkspaceLcuCapPerHour is the FGC-25 hard hourly cap. 0 → no hard cap.
	WorkspaceLcuCapPerHour float64 `json:"workspaceLcuCapPerHour"`
}

// DefaultPolicy is the default-ON, F2-equivalent, no-hard-cap policy.
func DefaultPolicy() Policy {
	return Policy{Enabled: true, CapacityCu: smoothing.DefaultCapacityCu, WorkspaceLcuCapPerHour: 0}
}

// AdmitRequest is the /admit body. Field names accept both the task's
// `requestedUnits` and the PRP's `estimatedLcu` (aliases; see UnmarshalJSON).
type AdmitRequest struct {
	TenantID     string  `json:"tenantId"`
	WorkspaceID  string  `json:"workspaceId"`
	Engine       string  `json:"engine"`
	RequestedLcu float64 `json:"requestedUnits"`
	Class        string  `json:"class"`
}

// UnmarshalJSON accepts the requested-LCU amount under either the task's
// `requestedUnits` or the PRP's `estimatedLcu` key (aliases), preferring
// whichever is present and non-zero.
func (a *AdmitRequest) UnmarshalJSON(data []byte) error {
	var raw struct {
		TenantID     string  `json:"tenantId"`
		WorkspaceID  string  `json:"workspaceId"`
		Engine       string  `json:"engine"`
		RequestedU   float64 `json:"requestedUnits"`
		EstimatedLcu float64 `json:"estimatedLcu"`
		Class        string  `json:"class"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	a.TenantID = raw.TenantID
	a.WorkspaceID = raw.WorkspaceID
	a.Engine = raw.Engine
	a.Class = raw.Class
	a.RequestedLcu = raw.RequestedU
	if a.RequestedLcu == 0 {
		a.RequestedLcu = raw.EstimatedLcu
	}
	return nil
}

// AdmitResult is the /admit response.
type AdmitResult struct {
	Decision            string  `json:"decision"` // allow | delay | reject
	DelayMs             int     `json:"delayMs,omitempty"`
	Reason              string  `json:"reason"`
	Backend             string  `json:"backend"` // ledger backend that served this (honest)
	Class               string  `json:"class"`
	Engine              string  `json:"engine"`
	RequestedLcu        float64 `json:"requestedLcu"`
	PerTimepointLcu     float64 `json:"perTimepointLcu"`
	CarryForwardSeconds int64   `json:"carryForwardSeconds"`
	LastHourLcu         float64 `json:"lastHourLcu"`
	Timepoint           int64   `json:"timepoint"`
	Bypassed            bool    `json:"bypassed,omitempty"` // policy disabled → metered but not throttled
}

// Broker holds the ledger + policy source.
type Broker struct {
	led    ledger.Ledger
	policy func(ctx context.Context, tenantID, workspaceID string) Policy
	now    func() time.Time
}

// New builds a Broker with a fixed default policy and the real clock. Callers
// can override the policy source and clock (tests use a fake clock).
func New(led ledger.Ledger) *Broker {
	return &Broker{
		led:    led,
		policy: func(context.Context, string, string) Policy { return DefaultPolicy() },
		now:    time.Now,
	}
}

// WithPolicy sets a per-workspace policy source.
func (b *Broker) WithPolicy(fn func(ctx context.Context, tenantID, workspaceID string) Policy) *Broker {
	b.policy = fn
	return b
}

// WithClock overrides the clock (deterministic tests).
func (b *Broker) WithClock(fn func() time.Time) *Broker {
	b.now = fn
	return b
}

// Backend exposes the active ledger backend name.
func (b *Broker) Backend() string { return b.led.Backend() }

// Ledger exposes the underlying ledger (for the /ledger read endpoint + health).
func (b *Broker) Ledger() ledger.Ledger { return b.led }

// Admit is the choke-point: it smooths the requested LCU across the class
// window, reads the projected future utilisation from the ledger, applies the
// four-stage throttle + the FGC-25 hard cap, and — for allow/delay — commits the
// spread to the ledger. Reject never commits.
func (b *Broker) Admit(ctx context.Context, req AdmitRequest) (AdmitResult, error) {
	class := smoothing.NormalizeClass(req.Class)
	pol := b.policy(ctx, req.TenantID, req.WorkspaceID)
	key := ledger.Key(req.TenantID, req.WorkspaceID)
	now := b.now().Unix()
	tp := smoothing.TimepointIndex(now)
	perTp := smoothing.SpreadPerTimepoint(req.RequestedLcu, class)
	n := smoothing.TimepointsFor(class)

	res := AdmitResult{
		Backend:         b.led.Backend(),
		Class:           string(class),
		Engine:          req.Engine,
		RequestedLcu:    req.RequestedLcu,
		PerTimepointLcu: perTp,
		Timepoint:       tp,
	}

	lastHour, err := b.led.LastHourLcu(ctx, key, tp)
	if err != nil {
		return res, err
	}
	res.LastHourLcu = lastHour

	// Policy disabled → meter (commit) but never throttle.
	if !pol.Enabled {
		if err := b.led.AddSpread(ctx, key, tp, perTp, n); err != nil {
			return res, err
		}
		res.Decision = string(smoothing.Allow)
		res.Bypassed = true
		res.Reason = "surge protection disabled — admitted unthrottled (metered)"
		return res, nil
	}

	// FGC-25 hard hourly cap (migrated static cap): a decisive reject before the
	// smoothed throttle even runs.
	if pol.WorkspaceLcuCapPerHour > 0 && lastHour+req.RequestedLcu > pol.WorkspaceLcuCapPerHour {
		res.Decision = string(smoothing.Reject)
		res.Reason = "workspace hourly LCU cap exceeded (FGC-25 surge protection)"
		return res, nil
	}

	// Project the future window WITH this job spread in, then decide.
	future, err := b.led.Future(ctx, key, tp, smoothing.BackgroundTimepoints)
	if err != nil {
		return res, err
	}
	for i := 0; i < n && i < len(future); i++ {
		future[i] += perTp
	}
	capPerTp := smoothing.CapacityPerTimepoint(pol.CapacityCu)
	cf := smoothing.CarryForwardSeconds(future, capPerTp)
	out := smoothing.DecideThrottle(cf, class)
	res.Decision = string(out.Decision)
	res.DelayMs = out.DelayMs
	res.Reason = out.Reason
	res.CarryForwardSeconds = out.CarryForwardSeconds

	// Commit the spread for admitted (allow/delay) jobs; reject does not consume.
	if out.Decision != smoothing.Reject {
		if err := b.led.AddSpread(ctx, key, tp, perTp, n); err != nil {
			return res, err
		}
	}
	return res, nil
}

// Report records ACTUAL post-run consumption (the /report endpoint), spreading
// it from the current timepoint like an admitted background job so the ledger
// reflects true consumption for chargeback reconciliation.
func (b *Broker) Report(ctx context.Context, tenantID, workspaceID string, actualLcu float64) error {
	key := ledger.Key(tenantID, workspaceID)
	tp := smoothing.TimepointIndex(b.now().Unix())
	perTp := smoothing.SpreadPerTimepoint(actualLcu, smoothing.Background)
	return b.led.AddSpread(ctx, key, tp, perTp, smoothing.BackgroundTimepoints)
}

// LedgerState is the timepoint snapshot the admin UI reads.
type LedgerState struct {
	Backend     string    `json:"backend"`
	Timepoint   int64     `json:"timepoint"`
	LastHourLcu float64   `json:"lastHourLcu"`
	Future      []float64 `json:"future"`
}

// State returns a bounded future window for the admin ledger endpoint.
func (b *Broker) State(ctx context.Context, tenantID, workspaceID string, horizon int) (LedgerState, error) {
	if horizon <= 0 || horizon > smoothing.BackgroundTimepoints {
		horizon = 120 // default: one hour of timepoints
	}
	key := ledger.Key(tenantID, workspaceID)
	tp := smoothing.TimepointIndex(b.now().Unix())
	future, err := b.led.Future(ctx, key, tp, horizon)
	if err != nil {
		return LedgerState{}, err
	}
	lastHour, err := b.led.LastHourLcu(ctx, key, tp)
	if err != nil {
		return LedgerState{}, err
	}
	return LedgerState{Backend: b.led.Backend(), Timepoint: tp, LastHourLcu: lastHour, Future: future}, nil
}
