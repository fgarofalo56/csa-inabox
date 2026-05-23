#!/usr/bin/env bash
# CSA Loom — Build 2026 freshness rescan driver
#
# Date-gated: do not run before Microsoft Build 2026 (June 2-3, 2026).
# Recommended execution window: week of 2026-06-08 through 2026-06-12.
#
# Purpose: re-validate the assumptions in temp/fiab-research/01..07.md
# after Build's announcement wave. New Fabric features, new Gov boundary
# availability, new model IDs, new pricing — all need fresh capture
# before Wave 2 (PRP-11/12/13) engineering begins.
#
# Usage:
#   scripts/csa-loom/build2026-rescan.sh
#
# Output: temp/fiab-research/rescan-build2026/RESCAN-RESULTS.md
#         + per-report deltas in rescan-build2026/01..07-delta.md

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
RESCAN_DIR="${REPO_ROOT}/temp/fiab-research/rescan-build2026"
TODAY=$(date -u +%Y-%m-%d)
BUILD_DATE="2026-06-03"
EARLIEST_RUN="2026-06-08"

mkdir -p "${RESCAN_DIR}"

# Date gate
if [[ "${TODAY}" < "${EARLIEST_RUN}" ]]; then
  echo "❌ Too early — Build 2026 freshness rescan should run on or after ${EARLIEST_RUN}"
  echo "   Today is ${TODAY}. Microsoft Build 2026 runs June 2-3."
  echo "   Re-run this script the week of June 8."
  exit 1
fi

echo "🔍 CSA Loom — Build 2026 freshness rescan starting"
echo "   Today: ${TODAY}"
echo "   Build 2026: ${BUILD_DATE}"
echo "   Output: ${RESCAN_DIR}/"
echo

# Capture rescan metadata
cat > "${RESCAN_DIR}/RESCAN-RESULTS.md" <<MDEOF
# CSA Loom — Build 2026 freshness rescan

**Rescan date:** ${TODAY}
**Source reports:** \`temp/fiab-research/01..07.md\` (original 2026-05-22)
**Triggered by:** Microsoft Build 2026 (June 2-3) + first week of follow-up Microsoft material

## Reports to revalidate

| Report | Original date | Key claims to recheck |
|---|---|---|
| 01-fabric-capability-surface.md | 2026-05-22 | New Fabric item types, GA dates, Direct Lake on OneLake updates, Fabric IQ family updates |
| 02-gov-boundary-availability.md | 2026-05-22 | Fabric Gov forecast updates, Foundry Agent Service Gov-GA confirmation, UC Gov region rollout, Defender for AI Gov rollout |
| 03-fabric-only-internals.md | 2026-05-22 | V-Order, VertiPaq transcoder, Direct Lake framing — any new openness from Microsoft? |
| 04-catalog-strategy.md | 2026-05-22 | UC Gov region announcements, Purview DoD scope updates |
| 05-eslz-marketplace.md | 2026-05-22 | Marketplace Managed App Gov updates (LD-4 was deferred — check if this changes) |
| 06-copilot-deploy.md | 2026-05-22 | New AOAI models, new MAF version, Foundry Agent Service updates |
| 07-existing-repo-scope.md | N/A (internal) | Skip — internal scope hasn't changed |

## Action checklist

For each of reports 01-06, perform the following and record deltas in
\`<report-num>-delta.md\`:

1. Re-run the Microsoft Docs MCP search for the same queries
2. Compare GA dates and feature claims
3. Identify any **newly announced** items that need Loom parity
4. Identify any **changed forecasts** for Gov availability
5. Identify any **new model IDs** (AOAI, Foundry, etc.)
6. Flag any **PRP that must be revised** based on deltas

## Critical questions to answer post-Build

1. **Did Microsoft announce Fabric for Gov?** If yes — when? GCC first?
   GCC-High next? IL5 timeline?
2. **Did Foundry Agent Service Gov-GA?** If yes — Loom Setup Wizard
   PRP-04 can simplify (drop MAF + AOAI direct fallback)
3. **Did UC land in usgovaz/usgovva?** If yes — PRP-12 catalog wiring
   simplifies; Hive metastore fallback retires
4. **Did Defender for Cloud AI Threat Protection Gov-GA?** If yes —
   PRP-13 Sentinel workaround retires
5. **Direct Lake on OneLake (no-fallback) in Gov?** If yes — PRP-08
   honest gap mitigates
6. **Any Fabric IQ items GA?** If yes — v2 roadmap accelerates
7. **HorizonDB in Gov?** If yes — v2 roadmap accelerates

## After rescan completes

1. Update affected PRP files with new constraints
2. Update \`temp/fiab-prd/AMENDMENTS.md\` with a new AMENDMENTS section
   dated post-Build
3. File GitHub issue against epic #279 with rescan findings summary
4. If LD decisions need to change → schedule walkthrough session

## Related

- Original research: \`temp/fiab-research/\` (01..07.md)
- PRD AMENDMENTS: \`temp/fiab-prd/AMENDMENTS.md\`
- Epic: #279
MDEOF

# Stub the 6 delta files for the rescan operator to fill in
for n in 01-fabric-capability-surface 02-gov-boundary-availability \
         03-fabric-only-internals 04-catalog-strategy \
         05-eslz-marketplace 06-copilot-deploy; do
  if [[ ! -f "${RESCAN_DIR}/${n}-delta.md" ]]; then
    cat > "${RESCAN_DIR}/${n}-delta.md" <<DELTAEOF
# Delta: ${n} — Build 2026 rescan ${TODAY}

**Original:** \`temp/fiab-research/${n}.md\`

## New since 2026-05-22

[List each new finding with citation]

## Changed since 2026-05-22

[List each changed claim with old → new + citation]

## Unchanged but reconfirmed

[List items that still hold]

## PRP impact

[List PRPs that need revision based on deltas]
DELTAEOF
  fi
done

echo "✅ Rescan scaffold ready at ${RESCAN_DIR}/"
echo "   Next steps:"
echo "   1. Open Microsoft Build 2026 session catalog + book of news"
echo "   2. For each of 01-06, run Microsoft Docs MCP searches"
echo "   3. Fill in ${RESCAN_DIR}/*-delta.md"
echo "   4. Update RESCAN-RESULTS.md with PRP impact summary"
echo "   5. File issue against epic #279 with findings"
