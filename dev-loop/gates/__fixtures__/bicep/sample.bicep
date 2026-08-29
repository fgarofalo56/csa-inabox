// Fixture for gate-selftest.ps1 cases S1-S6 (validate-bicep).
//
// It is COPIED into each synthetic tree rather than read in place, because
// every S-case needs a differently-shaped tree around the same known-good
// template (a committed sibling .json, a nested .claude/worktrees, an
// all-excluded root). Keeping the template itself here rather than as an
// inline string array follows the __fixtures__/typescript convention and means
// the thing the cases compile is a real file a human can compile by hand.
//
// Deliberately minimal and dependency-free: it must compile with `bicep build`
// alone, with no modules, no scope declaration and no ARM API version to age
// out from under the suite.
param location string = 'eastus'

output loc string = location
