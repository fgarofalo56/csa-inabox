package ledger

import (
	"context"
	"math"
	"testing"

	"loom-capacity-broker/internal/smoothing"
)

func TestMemoryAddSpreadAndFuture(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	key := Key("t1", "w1")
	// Spread 1.25 LCU across 2,880 background timepoints starting at 1000.
	if err := m.AddSpread(ctx, key, 1000, 1.25, smoothing.BackgroundTimepoints); err != nil {
		t.Fatal(err)
	}
	fut, err := m.Future(ctx, key, 1000, 5)
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range fut {
		if math.Abs(v-1.25) > 1e-9 {
			t.Fatalf("timepoint %d: got %v want 1.25", i, v)
		}
	}
}

func TestMemoryOverlappingJobsAccumulate(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	key := Key("t", "w")
	_ = m.AddSpread(ctx, key, 100, 10, 3) // 100,101,102 += 10
	_ = m.AddSpread(ctx, key, 101, 5, 3)  // 101,102,103 += 5
	fut, _ := m.Future(ctx, key, 100, 4)
	want := []float64{10, 15, 15, 5}
	for i := range want {
		if math.Abs(fut[i]-want[i]) > 1e-9 {
			t.Fatalf("bucket %d: got %v want %v (%v)", i, fut[i], want[i], fut)
		}
	}
}

func TestMemoryLastHourLcu(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	key := Key("t", "w")
	// Put 2 LCU in each of the last-hour timepoints ending at 5000.
	_ = m.AddSpread(ctx, key, 5000-int64(hourTimepoints)+1, 2, hourTimepoints)
	sum, err := m.LastHourLcu(ctx, key, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(sum-float64(hourTimepoints)*2) > 1e-6 {
		t.Fatalf("last-hour sum: got %v want %v", sum, float64(hourTimepoints)*2)
	}
}

func TestMemoryPrunesOldTimepoints(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	key := Key("t", "w")
	// Old spread far in the past.
	_ = m.AddSpread(ctx, key, 0, 9, 1)
	// A new spread 25 h later prunes the old one (outside the 24 h window).
	newStart := int64((25 * 3600) / 30)
	_ = m.AddSpread(ctx, key, newStart, 1, 1)
	fut, _ := m.Future(ctx, key, 0, 1)
	if fut[0] != 0 {
		t.Fatalf("expected old timepoint pruned, got %v", fut[0])
	}
}

func TestKeyStable(t *testing.T) {
	if Key("t", "w") != "lcu:t:w" {
		t.Fatal("key format changed")
	}
	if Key("t", "") != "lcu:t:_" {
		t.Fatal("empty workspace should fold to _")
	}
}

func TestMemoryBackendName(t *testing.T) {
	if NewMemory().Backend() != "memory" {
		t.Fatal("backend name")
	}
}
