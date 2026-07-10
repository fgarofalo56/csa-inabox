// Package smoothing is the PURE capacity-smoothing math core of the Loom
// Capacity Broker (HYP-9/HYP-10). It has no I/O, no clock, and no Redis — every
// function is a deterministic transformation over its inputs, so the golden
// tests in this package pin the exact numeric behaviour (the PSR-1
// "smoothing golden test").
//
// Model (grounded in Microsoft Learn's Fabric capacity docs — see the PRP
// citations: enterprise/throttling, data-warehouse/compute-capacity-smoothing-
// throttling, data-engineering/spark-job-concurrency-and-queueing):
//
//   - Time is bucketed into 30-second TIMEPOINTS. Fabric smooths billing across
//     up to 2,880 of them (24 h).
//   - An admitted job's LCU (Loom Capacity Unit, expressed as CU-seconds) cost is
//     SPREAD across N future timepoints per its class: interactive over 5 minutes
//     (10 timepoints), background over 24 hours (2,880 timepoints).
//   - Each timepoint offers a steady-state capacity of `capacityCu * 30`
//     CU-seconds. Bursting lets a job momentarily commit above that; smoothing
//     amortises the billing forward. A four-stage throttle is the backstop and it
//     self-heals as committed timepoints elapse.
//
// The LCU unit here is CU-seconds, so the Learn worked example holds exactly:
// a 1-CU-hour background job = 3600 CU-seconds spread over 2,880 timepoints =
// 1.25 LCU per timepoint.
package smoothing

// TimepointSeconds is the width of a single smoothing bucket.
const TimepointSeconds = 30

// Smoothing windows per class, in timepoints.
const (
	// InteractiveTimepoints spreads an interactive job over 5 minutes.
	InteractiveTimepoints = 10 // 5 min
	// BackgroundTimepoints spreads a background job over 24 hours (Fabric's max).
	BackgroundTimepoints = 2880 // 24 h
)

// Four-stage throttle thresholds, expressed as the future "carry-forward"
// horizon (how far into the future committed usage still exceeds capacity).
const (
	// OverageProtectionSeconds — below this, bursting is allowed with no throttle.
	OverageProtectionSeconds = 600 // 10 min
	// InteractiveThrottleCeilingSeconds — in [OverageProtection, this) interactive
	// requests are delayed; at/above it they are rejected.
	InteractiveThrottleCeilingSeconds = 3600 // 60 min
	// BackgroundRejectCeilingSeconds — at/above this even background is rejected.
	BackgroundRejectCeilingSeconds = 86400 // 24 h
	// DelayMs is the queue delay applied to a throttled interactive request
	// (Fabric's ~20s stage-2 behaviour).
	DelayMs = 20000
)

// DefaultCapacityCu is the steady-state capacity when a policy does not pin one
// (an F2-equivalent — 2 CU).
const DefaultCapacityCu = 2.0

// Class is a job's smoothing class.
type Class string

const (
	// Interactive jobs (queries, notebook cells, DAX) smooth over 5 minutes.
	Interactive Class = "interactive"
	// Background jobs (pipelines, training, framing) smooth over 24 hours.
	Background Class = "background"
)

// NormalizeClass coerces free-form input to a known class (default interactive,
// matching Fabric's default for ad-hoc submits).
func NormalizeClass(s string) Class {
	if s == string(Background) {
		return Background
	}
	return Interactive
}

// TimepointsFor returns the number of future timepoints a class spreads over.
func TimepointsFor(c Class) int {
	if c == Background {
		return BackgroundTimepoints
	}
	return InteractiveTimepoints
}

// TimepointIndex maps a Unix-seconds instant to its 30-second bucket index.
func TimepointIndex(unixSeconds int64) int64 {
	return unixSeconds / TimepointSeconds
}

// SpreadPerTimepoint returns the LCU each future timepoint receives when
// `totalLcu` (CU-seconds) is amortised across the job's class window.
//
// Golden invariant: SpreadPerTimepoint(3600, Background) == 1.25.
func SpreadPerTimepoint(totalLcu float64, c Class) float64 {
	n := TimepointsFor(c)
	if n <= 0 {
		return totalLcu
	}
	return totalLcu / float64(n)
}

// CapacityPerTimepoint is the CU-seconds a capacity of `capacityCu` offers per
// 30-second timepoint.
func CapacityPerTimepoint(capacityCu float64) float64 {
	if capacityCu <= 0 {
		capacityCu = DefaultCapacityCu
	}
	return capacityCu * TimepointSeconds
}

// CarryForwardSeconds measures how far into the future committed usage still
// exceeds capacity — the signal the throttle decision keys off. It walks the
// future timepoints in order accumulating usage and capacity; the horizon is the
// last timepoint at which cumulative usage still outruns cumulative capacity.
//
// A steadily-spread background load (1.25 vs a 60/timepoint cap) never outruns
// capacity, so its carry-forward is 0 → no throttle. A sustained burst above the
// per-timepoint cap accrues carry-forward proportional to how long the burst
// lasts. Pure: no clock, no state.
func CarryForwardSeconds(future []float64, capacityPerTimepoint float64) int64 {
	if capacityPerTimepoint <= 0 {
		capacityPerTimepoint = CapacityPerTimepoint(DefaultCapacityCu)
	}
	var cumUsage, cumCap float64
	lastOver := 0
	for i, u := range future {
		cumUsage += u
		cumCap += capacityPerTimepoint
		if cumUsage > cumCap {
			lastOver = i + 1
		}
	}
	return int64(lastOver) * TimepointSeconds
}

// Decision is the admission outcome. Values are the PRP-canonical
// allow/delay/reject; the task's admit/queue/reject are exact synonyms
// (admit=allow, queue=delay, reject=reject).
type Decision string

const (
	// Allow — dispatch immediately.
	Allow Decision = "allow"
	// Delay — queue the request for DelayMs then dispatch (Fabric stage-2).
	Delay Decision = "delay"
	// Reject — refuse the submit (Fabric stage-3/4).
	Reject Decision = "reject"
)

// Outcome is the full result of a throttle evaluation.
type Outcome struct {
	Decision            Decision `json:"decision"`
	DelayMs             int      `json:"delayMs,omitempty"`
	Reason              string   `json:"reason"`
	CarryForwardSeconds int64    `json:"carryForwardSeconds"`
}

// DecideThrottle applies the four-stage throttle to a carry-forward horizon for
// a given class. Pure — the golden test exercises every boundary.
func DecideThrottle(carryForwardSeconds int64, c Class) Outcome {
	out := Outcome{CarryForwardSeconds: carryForwardSeconds}
	switch {
	case carryForwardSeconds < OverageProtectionSeconds:
		out.Decision = Allow
		out.Reason = "within overage protection — burst allowed"
	case carryForwardSeconds < InteractiveThrottleCeilingSeconds:
		if c == Interactive {
			out.Decision = Delay
			out.DelayMs = DelayMs
			out.Reason = "smoothed usage 10-60 min over capacity — interactive request delayed"
		} else {
			out.Decision = Allow
			out.Reason = "background job smooths over 24 h — admitted"
		}
	case carryForwardSeconds < BackgroundRejectCeilingSeconds:
		if c == Interactive {
			out.Decision = Reject
			out.Reason = "smoothed usage 60 min-24 h over capacity — interactive request rejected"
		} else {
			out.Decision = Allow
			out.Reason = "background job admitted (interactive would be rejected at this load)"
		}
	default:
		out.Decision = Reject
		out.Reason = "smoothed usage exceeds 24 h of capacity — all requests rejected"
	}
	return out
}
