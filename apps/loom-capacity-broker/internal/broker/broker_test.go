package broker

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"loom-capacity-broker/internal/ledger"
	"loom-capacity-broker/internal/smoothing"
)

func fixedClock(unix int64) func() time.Time {
	return func() time.Time { return time.Unix(unix, 0) }
}

func TestAdmitSmallJobAllowsOnMemory(t *testing.T) {
	ctx := context.Background()
	b := New(ledger.NewMemory()).WithClock(fixedClock(30000))
	res, err := b.Admit(ctx, AdmitRequest{TenantID: "t", WorkspaceID: "w", Engine: "spark", RequestedLcu: 30, Class: "background"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != string(smoothing.Allow) {
		t.Fatalf("small job: got %q want allow (%s)", res.Decision, res.Reason)
	}
	if res.Backend != "memory" {
		t.Fatalf("backend: got %q want memory", res.Backend)
	}
	// The spread was committed — a subsequent state read sees the future usage.
	st, _ := b.State(ctx, "t", "w", 5)
	if st.Future[0] <= 0 {
		t.Fatal("expected committed spread in ledger")
	}
}

func TestAdmitHardCapRejects(t *testing.T) {
	ctx := context.Background()
	b := New(ledger.NewMemory()).WithClock(fixedClock(30000)).
		WithPolicy(func(context.Context, string, string) Policy {
			return Policy{Enabled: true, CapacityCu: smoothing.DefaultCapacityCu, WorkspaceLcuCapPerHour: 10}
		})
	res, err := b.Admit(ctx, AdmitRequest{TenantID: "t", WorkspaceID: "w", Engine: "spark", RequestedLcu: 25})
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != string(smoothing.Reject) {
		t.Fatalf("over hard cap: got %q want reject", res.Decision)
	}
}

func TestAdmitDisabledPolicyBypassesButMeters(t *testing.T) {
	ctx := context.Background()
	led := ledger.NewMemory()
	b := New(led).WithClock(fixedClock(30000)).
		WithPolicy(func(context.Context, string, string) Policy { return Policy{Enabled: false} })
	res, err := b.Admit(ctx, AdmitRequest{TenantID: "t", WorkspaceID: "w", Engine: "adx", RequestedLcu: 999999, Class: "interactive"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != string(smoothing.Allow) || !res.Bypassed {
		t.Fatalf("disabled policy: got %q bypassed=%v want allow+bypassed", res.Decision, res.Bypassed)
	}
	// Still metered.
	st, _ := b.State(ctx, "t", "w", 5)
	if st.Future[0] <= 0 {
		t.Fatal("disabled policy must still meter (commit spread)")
	}
}

func TestAdmitSustainedBurstDelaysInteractiveAllowsBackground(t *testing.T) {
	ctx := context.Background()
	led := ledger.NewMemory()
	now := int64(30000)
	tp := smoothing.TimepointIndex(now)
	// Seed 40 timepoints (20 min) at double the F2 per-timepoint cap (120 vs 60).
	if err := led.AddSpread(ctx, ledger.Key("t", "w"), tp, 120, 40); err != nil {
		t.Fatal(err)
	}
	b := New(led).WithClock(fixedClock(now))

	inter, err := b.Admit(ctx, AdmitRequest{TenantID: "t", WorkspaceID: "w", Engine: "adx", RequestedLcu: 1, Class: "interactive"})
	if err != nil {
		t.Fatal(err)
	}
	if inter.Decision != string(smoothing.Delay) {
		t.Fatalf("interactive under sustained burst: got %q want delay (cf=%ds)", inter.Decision, inter.CarryForwardSeconds)
	}
	if inter.DelayMs != smoothing.DelayMs {
		t.Fatalf("delayMs: got %d want %d", inter.DelayMs, smoothing.DelayMs)
	}

	bg, err := b.Admit(ctx, AdmitRequest{TenantID: "t", WorkspaceID: "w", Engine: "spark", RequestedLcu: 1, Class: "background"})
	if err != nil {
		t.Fatal(err)
	}
	if bg.Decision != string(smoothing.Allow) {
		t.Fatalf("background under same load: got %q want allow", bg.Decision)
	}
}

func TestAdmitRejectDoesNotCommit(t *testing.T) {
	ctx := context.Background()
	led := ledger.NewMemory()
	b := New(led).WithClock(fixedClock(30000)).
		WithPolicy(func(context.Context, string, string) Policy {
			return Policy{Enabled: true, CapacityCu: smoothing.DefaultCapacityCu, WorkspaceLcuCapPerHour: 5}
		})
	_, _ = b.Admit(ctx, AdmitRequest{TenantID: "t", WorkspaceID: "w", Engine: "spark", RequestedLcu: 25})
	st, _ := b.State(ctx, "t", "w", 5)
	if st.Future[0] != 0 {
		t.Fatalf("rejected job must not consume ledger, got %v", st.Future[0])
	}
}

func TestAdmitRequestAcceptsEstimatedLcuAlias(t *testing.T) {
	var req AdmitRequest
	if err := json.Unmarshal([]byte(`{"tenantId":"t","workspaceId":"w","engine":"spark","estimatedLcu":42,"class":"background"}`), &req); err != nil {
		t.Fatal(err)
	}
	if req.RequestedLcu != 42 {
		t.Fatalf("estimatedLcu alias: got %v want 42", req.RequestedLcu)
	}
	// requestedUnits takes precedence when present.
	if err := json.Unmarshal([]byte(`{"requestedUnits":7,"estimatedLcu":42}`), &req); err != nil {
		t.Fatal(err)
	}
	if req.RequestedLcu != 7 {
		t.Fatalf("requestedUnits precedence: got %v want 7", req.RequestedLcu)
	}
}

func TestReportCommitsActual(t *testing.T) {
	ctx := context.Background()
	led := ledger.NewMemory()
	b := New(led).WithClock(fixedClock(30000))
	if err := b.Report(ctx, "t", "w", 2880); err != nil {
		t.Fatal(err)
	}
	st, _ := b.State(ctx, "t", "w", 3)
	// 2880 LCU over 2880 background timepoints = 1.0 per timepoint.
	if st.Future[0] < 0.99 || st.Future[0] > 1.01 {
		t.Fatalf("report spread: got %v want ~1.0", st.Future[0])
	}
}
