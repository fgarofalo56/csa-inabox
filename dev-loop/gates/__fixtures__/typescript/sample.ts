// Control fixture for validate-typescript.ps1, exercised by gate-selftest.ps1.
//
// This file MUST typecheck cleanly. The self-test compiles it as-is and expects
// exit 0, then copies it to a temp directory, appends a deliberate type error,
// and expects exit 1. A gate whose verdict does not move between those two runs
// is not watching anything, which is the defect class behind #3811.
//
// The broken variant is generated at run time rather than committed, so that no
// deliberately-broken TypeScript sits in the tree waiting to be "tidied up" by
// someone who does not know it is load-bearing.

export interface GateResult {
  gate: string;
  status: 'Pass' | 'Fail' | 'NotRun';
}

export function measuredCount(results: readonly GateResult[]): number {
  return results.filter((r) => r.status === 'Pass' || r.status === 'Fail').length;
}

export function isVerified(results: readonly GateResult[]): boolean {
  return measuredCount(results) > 0;
}
