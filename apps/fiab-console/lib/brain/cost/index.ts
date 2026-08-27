/**
 * LOOM BRAIN — the cost layer. Public surface.
 *
 * One import path for everything cost-related:
 *
 *     import { readCostExport, attributeCost, renderCost } from '@/lib/brain/cost';
 *
 * The shared type contract lives in `../types` and reaches consumers through
 * `@/lib/brain/graph`; this module deliberately does NOT re-export it, so there
 * is exactly one place `CostFigure` comes from and no chance of two copies
 * drifting.
 *
 * ── THE ONE RULE ───────────────────────────────────────────────────────────
 * Every figure carries `source: 'billed' | 'derived'`, and a derived figure
 * cannot be rendered as a bill:
 *
 *     renderCost(figure)     → LabelledCost, provenance ALWAYS attached
 *     renderBilled(derived)  → COMPILE ERROR, and a throw if the type is cast
 *
 * Measured 2026-08-23: the Cost Management API returned HTTP 429 on ELEVEN
 * consecutive attempts over ~35 minutes, so every figure this program has
 * produced to date is `derived`. The export path (`./export-reader`) is the
 * route to a real `billed` figure, and its bicep module is
 * `platform/fiab/bicep/modules/admin-plane/cost-export.bicep`. That export's
 * first data lands roughly 24 hours after it is created — it is a daily drop,
 * not a live feed, and `CostExportRead.asOf` carries which run a figure is from.
 *
 * ── NOTHING HERE MUTATES AZURE ─────────────────────────────────────────────
 * Every module under `lib/brain/cost` is pure: data in, data out. No Azure
 * client, no fetch, no code path that could scale or delete a resource
 * (PRP §1 decision 1).
 */

export {
  BILLED_MARKER,
  DERIVED_MARKER,
  isBilled,
  isDerived,
  renderBilled,
  renderCost,
  renderDerived,
  renderRollup,
  rollup,
  type BilledFigure,
  type CostFigureInvariants,
  type CostRollup,
  type DerivedFigure,
  type LabelledCost,
} from './figure';

export {
  describeReadPopulation,
  makeReadPopulation,
  type ReadPopulation,
  type ReadSubject,
} from './population';

export {
  BUILT_IN_RATE_CARDS,
  cloudForRegion,
  CONTAINER_APPS_RATES_COMMERCIAL,
  CONTAINER_APPS_RATES_USGOV,
  rateCardFor,
  RATES_READ_ON,
  SECONDS_PER_MONTH,
  type ContainerAppsRateCard,
  type RateCloud,
} from './rate-card';

export {
  boundOf,
  CONTAINER_APP_TYPE,
  deriveContainerAppCost,
  isBand,
  parseMemoryGib,
  type DerivationOutcome,
  type DerivationSkip,
  type DerivedCostBand,
} from './derived';

export {
  ASOF_NOT_ESTABLISHED,
  bindColumns,
  parseCsvFields,
  parseManifest,
  readCostExport,
  schemaOf,
  splitCsvRecords,
  SKIP_SAMPLE_CAP,
  type BoundColumns,
  type Completeness,
  type CostExportInput,
  type CostExportRead,
  type ExportManifest,
  type ExportPartition,
  type ExportSchema,
  type ManifestFacts,
} from './export-reader';

export {
  attributeCost,
  attributionFor,
  type AttributeCostOptions,
  type BilledSource,
  type CostAttribution,
  type CostAttributionResult,
} from './attribute';
