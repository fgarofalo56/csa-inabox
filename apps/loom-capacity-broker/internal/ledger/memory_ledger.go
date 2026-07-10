package ledger

import (
	"context"
	"sync"
)

// Memory is the in-process ledger: map[key]map[timepoint]lcu with a mutex and
// lazy pruning of timepoints older than the 24 h window. Single-replica by
// nature (per-ACA-replica state) — the honest limitation the response reports so
// the operator knows to set LOOM_BROKER_REDIS for cross-replica coherence.
type Memory struct {
	mu   sync.Mutex
	data map[string]map[int64]float64
}

// NewMemory constructs an empty in-memory ledger.
func NewMemory() *Memory {
	return &Memory{data: make(map[string]map[int64]float64)}
}

// Backend implements Ledger.
func (m *Memory) Backend() string { return "memory" }

// AddSpread implements Ledger.
func (m *Memory) AddSpread(_ context.Context, key string, startTimepoint int64, perTimepoint float64, n int) error {
	if perTimepoint == 0 || n <= 0 {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	buckets := m.data[key]
	if buckets == nil {
		buckets = make(map[int64]float64)
		m.data[key] = buckets
	}
	for i := 0; i < n; i++ {
		buckets[startTimepoint+int64(i)] += perTimepoint
	}
	// Prune anything older than 24 h before the spread's start (self-heal: elapsed
	// debt drops out of the window automatically).
	cutoff := startTimepoint - int64(24*3600/30)
	for tp := range buckets {
		if tp < cutoff {
			delete(buckets, tp)
		}
	}
	return nil
}

// Future implements Ledger.
func (m *Memory) Future(_ context.Context, key string, startTimepoint int64, horizon int) ([]float64, error) {
	out := make([]float64, horizon)
	m.mu.Lock()
	defer m.mu.Unlock()
	buckets := m.data[key]
	if buckets == nil {
		return out, nil
	}
	for i := 0; i < horizon; i++ {
		out[i] = buckets[startTimepoint+int64(i)]
	}
	return out, nil
}

// LastHourLcu implements Ledger.
func (m *Memory) LastHourLcu(_ context.Context, key string, startTimepoint int64) (float64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	buckets := m.data[key]
	if buckets == nil {
		return 0, nil
	}
	var sum float64
	for i := 0; i < hourTimepoints; i++ {
		sum += buckets[startTimepoint-int64(i)]
	}
	return sum, nil
}

// Ping implements Ledger (memory is always healthy).
func (m *Memory) Ping(_ context.Context) error { return nil }

// Close implements Ledger.
func (m *Memory) Close() error { return nil }
