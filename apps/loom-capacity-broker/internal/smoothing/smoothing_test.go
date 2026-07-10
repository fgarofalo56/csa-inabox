package smoothing

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

type goldenFile struct {
	SpreadCases []struct {
		Name                string  `json:"name"`
		TotalLcu            float64 `json:"totalLcu"`
		Class               string  `json:"class"`
		ExpectedPerTimepoint float64 `json:"expectedPerTimepoint"`
	} `json:"spreadCases"`
	DecideCases []struct {
		Name                string `json:"name"`
		CarryForwardSeconds int64  `json:"carryForwardSeconds"`
		Class               string `json:"class"`
		Expected            string `json:"expected"`
		ExpectedDelayMs     int    `json:"expectedDelayMs"`
	} `json:"decideCases"`
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "smoothing_golden.json"))
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var g goldenFile
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	return g
}

const eps = 1e-9

// TestSmoothingGolden is the named PSR-1 "smoothing golden test": it pins the
// exact amortisation numbers and every throttle boundary against the golden file.
func TestSmoothingGolden(t *testing.T) {
	g := loadGolden(t)
	if len(g.SpreadCases) == 0 || len(g.DecideCases) == 0 {
		t.Fatal("golden file has no cases")
	}

	for _, c := range g.SpreadCases {
		got := SpreadPerTimepoint(c.TotalLcu, NormalizeClass(c.Class))
		if math.Abs(got-c.ExpectedPerTimepoint) > eps {
			t.Errorf("spread %q: got %v want %v", c.Name, got, c.ExpectedPerTimepoint)
		}
	}

	for _, c := range g.DecideCases {
		out := DecideThrottle(c.CarryForwardSeconds, NormalizeClass(c.Class))
		if string(out.Decision) != c.Expected {
			t.Errorf("decide %q: got %q want %q", c.Name, out.Decision, c.Expected)
		}
		if out.DelayMs != c.ExpectedDelayMs {
			t.Errorf("decide %q: delayMs got %d want %d", c.Name, out.DelayMs, c.ExpectedDelayMs)
		}
	}
}

// TestBackgroundWorkedExampleIs1_25 states the Learn worked example directly so
// the invariant is legible even without the golden file.
func TestBackgroundWorkedExampleIs1_25(t *testing.T) {
	// 1 CU-hour = 3600 CU-seconds spread across 2,880 background timepoints.
	if got := SpreadPerTimepoint(3600, Background); math.Abs(got-1.25) > eps {
		t.Fatalf("1 CU-hour background: got %v want 1.25 per timepoint", got)
	}
}

func TestCarryForwardZeroForSteadyBackground(t *testing.T) {
	cap := CapacityPerTimepoint(DefaultCapacityCu) // 60 CU-seconds/timepoint
	// A negligible steady background load never outruns capacity.
	future := make([]float64, 2880)
	for i := range future {
		future[i] = 1.25
	}
	if cf := CarryForwardSeconds(future, cap); cf != 0 {
		t.Fatalf("steady background carry-forward: got %ds want 0", cf)
	}
}

func TestCarryForwardTracksSustainedBurst(t *testing.T) {
	cap := CapacityPerTimepoint(DefaultCapacityCu) // 60
	// 30 timepoints (15 min) at double the per-timepoint cap → cumulative usage
	// outruns cumulative capacity the whole way → 15 min carry-forward.
	future := make([]float64, 30)
	for i := range future {
		future[i] = 120
	}
	cf := CarryForwardSeconds(future, cap)
	if cf != 30*TimepointSeconds {
		t.Fatalf("sustained 15-min burst: got %ds want %ds", cf, 30*TimepointSeconds)
	}
	// That horizon must throttle an interactive request but not a background one.
	if DecideThrottle(cf, Interactive).Decision != Delay {
		t.Errorf("15-min burst interactive: expected delay")
	}
	if DecideThrottle(cf, Background).Decision != Allow {
		t.Errorf("15-min burst background: expected allow")
	}
}

func TestCarryForwardAtExactCapacityIsZero(t *testing.T) {
	cap := CapacityPerTimepoint(DefaultCapacityCu) // 60
	// Running exactly at the per-timepoint cap is not an overage.
	future := make([]float64, 20)
	for i := range future {
		future[i] = 60
	}
	if cf := CarryForwardSeconds(future, cap); cf != 0 {
		t.Fatalf("at-capacity carry-forward: got %ds want 0", cf)
	}
}

func TestTimepointIndexMonotonic(t *testing.T) {
	if TimepointIndex(0) != 0 || TimepointIndex(29) != 0 || TimepointIndex(30) != 1 || TimepointIndex(61) != 2 {
		t.Fatal("TimepointIndex bucketing wrong")
	}
}

func TestNormalizeClassDefaultsInteractive(t *testing.T) {
	if NormalizeClass("") != Interactive || NormalizeClass("nonsense") != Interactive {
		t.Fatal("unknown class must default to interactive")
	}
	if NormalizeClass("background") != Background {
		t.Fatal("background must parse")
	}
}
