/**
 * LOOM BRAIN — read a Cost Management EXPORT and attribute billed cost per
 * resource id.
 *
 * PRP §1 decision 3, verbatim: "Real cost comes from a Cost Management export
 * to storage, not the live API. The API returned HTTP 429 on 11 consecutive
 * attempts over ~35 minutes; every dollar figure produced so far is *derived*."
 * This module is the reader for the other side of that decision.
 * `../../../platform/fiab/bicep/modules/admin-plane/cost-export.bicep`
 * provisions the export; this parses what it drops in the container.
 *
 * ── LATENCY, STATED PLAINLY ────────────────────────────────────────────────
 * A daily export is NOT a live feed. The first run lands roughly 24 hours after
 * the export is created, each subsequent run once a day, and Azure's own
 * guidance notes a brand-new subscription can take up to 48 hours before Cost
 * Management features return anything at all. So a figure read here is billed —
 * but it is billed AS OF the export run, and {@link CostExportRead.asOf}
 * carries that instant. Presenting it as "current spend" would be a claim about
 * a moment the data does not cover.
 *
 * ── FOUR WAYS THIS READER COULD LIE, AND WHAT STOPS EACH ────────────────────
 *
 * 1. PARTIAL READ. Exports are ALWAYS partitioned — Azure states partitioning
 *    cannot be disabled and applies even to small exports — so a run is N blobs
 *    plus a `manifest.json`. Reading three of four partitions and summing them
 *    yields a confident, low, wrong total. That is this repo's single most
 *    repeated failure shape. So: the manifest is parsed, its `blobs[]` and
 *    `dataRowCount` are compared against what was actually supplied, and the
 *    result carries {@link Completeness}. WITHOUT a manifest the answer is
 *    `'unknown'` — never `'complete'`.
 *
 * 2. WRONG COLUMN. The cost column is named differently per agreement:
 *    `BilledCost` (FOCUS), `CostInBillingCurrency` (EA/MCA current),
 *    `Cost`/`PreTaxCost` (legacy EA). A reader hard-coded to one of them
 *    returns ZERO for every other agreement type — a silent, total, plausible
 *    failure. So the header is matched against ordered candidate lists, and the
 *    columns actually matched are REPORTED in {@link CostExportRead.columns}.
 *    No match for the cost column means the read is blind, not empty.
 *
 * 3. WRONG CURRENCY. Every figure in the Brain is `amountUsd`. An export whose
 *    `BillingCurrency` is EUR carries EUR in `CostInBillingCurrency`, and
 *    copying that into `amountUsd` mislabels the unit — a false claim under R7,
 *    and one that looks entirely normal on screen. So: an explicit USD column
 *    wins; failing that the currency must READ as USD; failing that the row is
 *    SKIPPED with the currency named. There is no conversion, because there is
 *    no exchange rate this module could establish.
 *
 * 4. NAIVE CSV SPLIT. The `Tags` column is a quoted JSON-ish blob containing
 *    commas, and `AdditionalInfo` likewise. `line.split(',')` shifts every
 *    subsequent column on those rows, so `ResourceId` silently becomes a
 *    fragment of a tag value and the row attributes to nothing. So this module
 *    carries a real RFC 4180 field parser, quotes and doubled-quotes included.
 *
 * ── POPULATION (PRP §3.2) ──────────────────────────────────────────────────
 * The result reports rows examined, rows attributed, rows skipped WITH reasons,
 * and partitions examined. A reader that attributes nothing over 40 000 rows
 * and a reader handed no file at all are different states, and both are visible
 * here rather than collapsing into "$0.00".
 *
 * PURE. Takes blob names and their text; performs no I/O and holds no Azure
 * client. Fetching the blobs is a caller's job.
 */

import { azureResourceNodeId } from '../graph/node-id';
import { billedCost, type NodeId, type SkippedSubject } from '../types';
import type { BilledFigure } from './figure';
import { makeReadPopulation, type ReadPopulation } from './population';

// ---------------------------------------------------------------------------
// §Inputs
// ---------------------------------------------------------------------------

/** One partition blob of an export run, already fetched. */
export interface ExportPartition {
  /** Blob name as it appears in the container. Compared against the manifest. */
  readonly blobName: string;
  /** The partition's CSV text, header row included. */
  readonly csv: string;
}

/** The `manifest.json` that accompanies every export run. */
export interface ExportManifest {
  readonly blobName: string;
  readonly json: string;
}

/** One export run: its manifest (when available) and its partitions. */
export interface CostExportInput {
  /** The export's name, for the figures' `basis`. */
  readonly exportName: string;
  /**
   * The manifest. OPTIONAL, and its absence is not an error — but it downgrades
   * completeness to `'unknown'`, because without it there is nothing to compare
   * the supplied partitions against.
   */
  readonly manifest?: ExportManifest;
  readonly partitions: readonly ExportPartition[];
  /**
   * Accept a currency-less export as USD. Defaults to FALSE: with no currency
   * column and no manifest currency, the code has not established the unit, so
   * it skips rather than assuming (R7). Set this only when the operator has
   * confirmed the billing currency out of band, and it is recorded in the
   * figures' `basis`.
   */
  readonly assumeUsdWhenCurrencyAbsent?: boolean;
}

// ---------------------------------------------------------------------------
// §Outputs
// ---------------------------------------------------------------------------

/**
 * Whether every partition of the run was read.
 *
 * `'unknown'` is a first-class answer, not a soft `'complete'`. A total summed
 * over an unknown fraction of the data is not a total.
 */
export type Completeness = 'complete' | 'incomplete' | 'unknown';

/** Which agreement's column set the header matched. */
export type ExportSchema = 'focus' | 'ea-mca' | 'legacy-ea' | 'unrecognized';

/** The header columns this reader actually bound, by role. `null` = no match. */
export interface BoundColumns {
  readonly resourceId: string | null;
  readonly cost: string | null;
  /** An explicitly-USD cost column, when the schema offers one. */
  readonly usdCost: string | null;
  readonly currency: string | null;
  readonly date: string | null;
}

/** The outcome of reading one export run. */
export interface CostExportRead {
  readonly exportName: string;
  readonly schema: ExportSchema;
  readonly columns: BoundColumns;
  readonly completeness: Completeness;
  /** Why completeness is what it is. Always populated, including on 'complete'. */
  readonly completenessDetail: string;
  /** Billed USD per canonical {@link NodeId}. Summed across rows and partitions. */
  readonly byResource: ReadonlyMap<NodeId, BilledFigure>;
  /** Rows examined across every supplied partition (header rows excluded). */
  readonly population: ReadPopulation;
  /** Partitions examined — a second population, since a row count hides a missing file. */
  readonly partitionPopulation: ReadPopulation;
  readonly rowsAttributed: number;
  readonly rowsSkipped: number;
  /** Every skip, with its reason. Capped; see {@link SKIP_SAMPLE_CAP}. */
  readonly skipped: readonly SkippedSubject[];
  /** How many skips were elided by the cap. */
  readonly skippedElided: number;
  /**
   * The instant this data is billed AS OF — the manifest's run end date or
   * submitted time when present, else `null`. `null` means NOT ESTABLISHED, and
   * downstream must not print a date it does not have.
   */
  readonly asOf: string | null;
  /**
   * How the FIRST attributed row's currency was resolved — explicit USD column,
   * a currency column reading USD, or caller opt-in. `null` when nothing was
   * attributed.
   *
   * Its own field rather than an entry in {@link skipped}: an INFO line in a
   * list named "skipped" is exactly the kind of category smear that makes a
   * count untrustworthy later.
   */
  readonly currencyResolution: string | null;
}

/**
 * Stands in for {@link CostExportRead.asOf} inside a figure's `asOf` when the
 * manifest did not establish a run date.
 *
 * Deliberately NOT the empty string and NOT a plausible date: a renderer that
 * prints this shows a loud marker, where `''` would render as a blank that
 * reads like "no charge yet" and a substituted `Date.now()` would be a
 * fabricated timestamp (R7).
 */
export const ASOF_NOT_ESTABLISHED = 'NOT-ESTABLISHED';

/**
 * Skips are sampled rather than accumulated without bound: a 40 000-row export
 * whose currency is not USD would otherwise build a 40 000-entry array of
 * identical reasons. The COUNT is always exact; only the samples are capped.
 */
export const SKIP_SAMPLE_CAP = 50;

// ---------------------------------------------------------------------------
// §CSV — a real parser, because `split(',')` corrupts the Tags column
// ---------------------------------------------------------------------------

/**
 * Split one CSV record into fields, honouring RFC 4180 quoting: `"a,b"` is one
 * field, and `""` inside a quoted field is a literal quote.
 *
 * Exported for its own test — this is the function whose failure mode is
 * silent, so it is exercised directly rather than only through the reader.
 */
export function parseCsvFields(record: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < record.length; i += 1) {
    const ch = record[i];
    if (inQuotes) {
      if (ch === '"') {
        if (record[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Split CSV text into records, keeping quoted newlines inside their field.
 *
 * Handles CRLF and LF. A quoted field containing a newline is a single record —
 * `text.split('\n')` would tear it in half and desynchronise every column after
 * it.
 */
export function splitCsvRecords(text: string): string[] {
  // Strip a UTF-8 BOM. Azure export CSVs frequently carry one, and without this
  // the first header name becomes '﻿InvoiceSectionName', no candidate
  // matches, and the reader reports 'unrecognized' over a perfectly good file.
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === '"') {
      if (inQuotes && t[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && t[i + 1] === '\n') i += 1;
      records.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length > 0) records.push(current);
  return records.filter((r) => r.trim().length > 0);
}

// ---------------------------------------------------------------------------
// §Column binding
// ---------------------------------------------------------------------------

/**
 * Candidate header names per role, most-specific first.
 *
 * Every entry is a column name Microsoft publishes for one of the cost-and-usage
 * schemas. The ORDER matters: FOCUS's explicitly-USD columns are preferred over
 * its billing-currency ones, so an export in a non-USD agreement still yields
 * correct USD rather than being skipped.
 */
const CANDIDATES = {
  resourceId: ['ResourceId', 'InstanceId', 'instanceId', 'resourceid'],
  /** Billing-currency cost. */
  cost: ['BilledCost', 'CostInBillingCurrency', 'PreTaxCost', 'Cost', 'costInBillingCurrency'],
  /** Explicitly-USD cost. Preferred whenever present. */
  usdCost: ['x_BilledCostInUsd', 'x_EffectiveCostInUsd', 'CostInUsd', 'PaygCostInUSD'],
  currency: ['BillingCurrency', 'BillingCurrencyCode', 'Currency', 'currency'],
  date: ['ChargePeriodStart', 'Date', 'UsageDateTime', 'date'],
} as const;

function bindColumn(header: readonly string[], candidates: readonly string[]): string | null {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i >= 0) return header[i].trim();
  }
  return null;
}

function indexOfColumn(header: readonly string[], name: string | null): number {
  if (name === null) return -1;
  return header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

/** Bind every role against a header row. Exported for direct testing. */
export function bindColumns(header: readonly string[]): BoundColumns {
  return {
    resourceId: bindColumn(header, CANDIDATES.resourceId),
    cost: bindColumn(header, CANDIDATES.cost),
    usdCost: bindColumn(header, CANDIDATES.usdCost),
    currency: bindColumn(header, CANDIDATES.currency),
    date: bindColumn(header, CANDIDATES.date),
  };
}

/** Which schema the bound cost column implies. */
export function schemaOf(columns: BoundColumns): ExportSchema {
  if (columns.cost === null && columns.usdCost === null) return 'unrecognized';
  const cost = (columns.cost ?? '').toLowerCase();
  if (cost === 'billedcost' || columns.usdCost?.startsWith('x_')) return 'focus';
  if (cost === 'costinbillingcurrency') return 'ea-mca';
  if (cost === 'cost' || cost === 'pretaxcost') return 'legacy-ea';
  return 'unrecognized';
}

// ---------------------------------------------------------------------------
// §Manifest
// ---------------------------------------------------------------------------

/** What the manifest established. Every field is nullable: absent ≠ zero. */
export interface ManifestFacts {
  readonly blobNames: readonly string[] | null;
  readonly dataRowCount: number | null;
  readonly asOf: string | null;
  readonly currency: string | null;
  readonly parseError: string | null;
}

/**
 * Parse the run manifest defensively.
 *
 * Never throws: a malformed manifest must degrade the answer to `'unknown'`
 * completeness, not abort a read that would otherwise produce usable rows. The
 * parse error is carried so the reason is visible rather than inferred.
 */
export function parseManifest(json: string): ManifestFacts {
  const empty: ManifestFacts = {
    blobNames: null,
    dataRowCount: null,
    asOf: null,
    currency: null,
    parseError: null,
  };
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (e) {
    return { ...empty, parseError: e instanceof Error ? e.message : String(e) };
  }
  if (typeof doc !== 'object' || doc === null) {
    return { ...empty, parseError: 'manifest is not a JSON object' };
  }
  const d = doc as Record<string, unknown>;
  const blobs = Array.isArray(d.blobs) ? (d.blobs as unknown[]) : null;
  const blobNames = blobs
    ? blobs
        .map((b) =>
          typeof b === 'object' && b !== null
            ? String((b as Record<string, unknown>).blobName ?? '')
            : '',
        )
        .filter((n) => n.length > 0)
    : null;
  const rows = typeof d.dataRowCount === 'number' ? d.dataRowCount : null;
  const runInfo =
    typeof d.runInfo === 'object' && d.runInfo !== null
      ? (d.runInfo as Record<string, unknown>)
      : null;
  const asOfRaw = runInfo?.endDate ?? runInfo?.submittedTime ?? null;
  const exportConfig =
    typeof d.exportConfig === 'object' && d.exportConfig !== null
      ? (d.exportConfig as Record<string, unknown>)
      : null;
  const currencyRaw = d.billingCurrency ?? exportConfig?.billingCurrency ?? null;
  return {
    blobNames: blobNames && blobNames.length > 0 ? blobNames : null,
    dataRowCount: rows,
    asOf: typeof asOfRaw === 'string' && asOfRaw.trim() ? asOfRaw.trim() : null,
    currency: typeof currencyRaw === 'string' && currencyRaw.trim() ? currencyRaw.trim() : null,
    parseError: null,
  };
}

/** Blob names are full paths in the manifest; compare on the last segment. */
function basename(p: string): string {
  const s = p.replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

// ---------------------------------------------------------------------------
// §The read
// ---------------------------------------------------------------------------

function emptyColumns(): BoundColumns {
  return { resourceId: null, cost: null, usdCost: null, currency: null, date: null };
}

/**
 * Read one export run into billed cost per resource.
 *
 * NEVER THROWS on bad data — every failure becomes a skip with a reason, or a
 * blind population, because a reader that throws on the first odd row destroys
 * the 39 999 good ones and tells the operator nothing about either.
 */
export function readCostExport(input: CostExportInput): CostExportRead {
  const manifestFacts: ManifestFacts | null = input.manifest
    ? parseManifest(input.manifest.json)
    : null;

  const partitionPopulation = makeReadPopulation({
    subject: 'partitions',
    examined: input.partitions.length,
    scope: `export '${input.exportName}', ${
      manifestFacts?.blobNames
        ? `${manifestFacts.blobNames.length} listed in manifest`
        : 'no manifest blob list'
    }`,
  });

  // ── Completeness, decided BEFORE any row is read ────────────────────────
  let completeness: Completeness = 'unknown';
  let completenessDetail: string;
  if (!input.manifest) {
    completenessDetail =
      'no manifest supplied — exports are always partitioned, so the number of partitions ' +
      'in this run cannot be established. Any total is over an UNKNOWN fraction of the data.';
  } else if (manifestFacts?.parseError) {
    completenessDetail = `manifest '${input.manifest.blobName}' did not parse (${manifestFacts.parseError}) — completeness cannot be established.`;
  } else if (!manifestFacts?.blobNames) {
    completenessDetail = `manifest '${input.manifest.blobName}' carries no blobs[] list — completeness cannot be established.`;
  } else {
    const supplied = new Set(input.partitions.map((p) => basename(p.blobName)));
    const missing = manifestFacts.blobNames.filter((n) => !supplied.has(basename(n)));
    const extra = input.partitions
      .map((p) => p.blobName)
      .filter((n) => !manifestFacts.blobNames!.some((m) => basename(m) === basename(n)));
    if (missing.length === 0 && extra.length === 0) {
      completeness = 'complete';
      completenessDetail = `all ${manifestFacts.blobNames.length} manifest partition(s) supplied.`;
    } else {
      completeness = 'incomplete';
      completenessDetail =
        `manifest lists ${manifestFacts.blobNames.length} partition(s); ` +
        `${missing.length} MISSING${missing.length ? ` (${missing.slice(0, 5).map(basename).join(', ')})` : ''}` +
        `${extra.length ? `, ${extra.length} supplied but not listed (${extra.slice(0, 5).map(basename).join(', ')})` : ''}. ` +
        'Any total here is a PARTIAL read.';
    }
  }

  // ── Rows ────────────────────────────────────────────────────────────────
  const byResource = new Map<NodeId, { usd: number; rows: number }>();
  const skipped: SkippedSubject[] = [];
  let skippedElided = 0;
  let rowsExamined = 0;
  let rowsAttributed = 0;
  let rowsSkipped = 0;
  let columns: BoundColumns = emptyColumns();
  let sawAnyHeader = false;
  let currencyResolution: string | null = null;

  /** A skipped ROW. Increments the row counter and respects the sample cap. */
  const note = (subject: string, reason: string): void => {
    rowsSkipped += 1;
    if (skipped.length < SKIP_SAMPLE_CAP) skipped.push({ subject, reason });
    else skippedElided += 1;
  };

  /** A skipped PARTITION or file-level problem. Not a row, so no row counter. */
  const noteFile = (subject: string, reason: string): void => {
    if (skipped.length < SKIP_SAMPLE_CAP) skipped.push({ subject, reason });
    else skippedElided += 1;
  };

  for (const partition of input.partitions) {
    const records = splitCsvRecords(partition.csv);
    if (records.length === 0) {
      noteFile(partition.blobName, 'partition is empty — no header, no rows');
      continue;
    }
    const header = parseCsvFields(records[0]).map((h) => h.trim());
    const bound = bindColumns(header);
    if (!sawAnyHeader) {
      columns = bound;
      sawAnyHeader = true;
    }
    const idIdx = indexOfColumn(header, bound.resourceId);
    const costIdx = indexOfColumn(header, bound.cost);
    const usdIdx = indexOfColumn(header, bound.usdCost);
    const curIdx = indexOfColumn(header, bound.currency);

    // BOTH roles are checked before either is reported. Reporting only the
    // first missing one sends a reader looking for a resource-id column in a
    // file that also has no cost column, and they find that out on the second
    // pass — so every missing role is named in one message.
    const missingRoles: string[] = [];
    if (idIdx < 0) {
      missingRoles.push(
        `no resource-id column (looked for ${CANDIDATES.resourceId.join('/')})`,
      );
    }
    if (costIdx < 0 && usdIdx < 0) {
      missingRoles.push(
        `no cost column (looked for ${[...CANDIDATES.usdCost, ...CANDIDATES.cost].join('/')})`,
      );
    }
    if (missingRoles.length > 0) {
      noteFile(
        partition.blobName,
        `${missingRoles.join('; ')}. Header has ${header.length} column(s): ` +
          `${header.slice(0, 8).join(', ')}${header.length > 8 ? ', …' : ''}. ` +
          'This partition is UNRECOGNISED, not zero-cost — its rows were counted but none could be attributed.',
      );
      rowsExamined += records.length - 1;
      rowsSkipped += records.length - 1;
      continue;
    }

    for (let r = 1; r < records.length; r += 1) {
      rowsExamined += 1;
      const fields = parseCsvFields(records[r]);
      const rawId = (fields[idIdx] ?? '').trim();
      if (!rawId) {
        // Purchases, unused reservations and rounding adjustments legitimately
        // carry no resource id. Recorded, because "not attributable" is a fact
        // about the row, not a defect.
        note(`${partition.blobName}#${r}`, 'row has no resource id (purchase, reservation or adjustment) — not attributable to a resource');
        continue;
      }

      // Currency, decided per row: an explicit USD column wins; otherwise the
      // billing currency must READ as USD. There is no conversion.
      let usdText: string | undefined;
      let currencyNote: string;
      const explicitUsd = usdIdx >= 0 ? (fields[usdIdx] ?? '').trim() : '';
      if (explicitUsd) {
        usdText = explicitUsd;
        currencyNote = `explicit USD column '${bound.usdCost}'`;
      } else {
        const currency = (curIdx >= 0 ? (fields[curIdx] ?? '').trim() : manifestFacts?.currency ?? '')
          .toUpperCase();
        if (currency === 'USD') {
          usdText = (fields[costIdx] ?? '').trim();
          currencyNote = `column '${bound.cost}', currency reads USD`;
        } else if (!currency && input.assumeUsdWhenCurrencyAbsent) {
          usdText = (fields[costIdx] ?? '').trim();
          currencyNote = `column '${bound.cost}', currency NOT PRESENT — treated as USD by explicit caller opt-in`;
        } else if (!currency) {
          note(
            `${partition.blobName}#${r}`,
            'billing currency not established (no currency column, no manifest currency, no caller opt-in) — ' +
              'refusing to record a non-USD amount as USD',
          );
          continue;
        } else {
          note(
            `${partition.blobName}#${r}`,
            `billing currency is '${currency}', not USD, and no explicit USD column is present — ` +
              'refusing to convert; there is no exchange rate this reader can establish',
          );
          continue;
        }
      }

      // An EMPTY cost cell is NOT $0.00, and the finite check below CANNOT
      // catch it: `Number('')` is 0 and `Number.isFinite(0)` is true, so a blank
      // sails through and is attributed as a genuine billed zero. Measured on
      // this file before this guard existed — a row with a resource id and an
      // empty cost cell produced `byResource.size=1, rowsAttributed=1,
      // rowsSkipped=0`, rendering as `$0.00 (billed, …)`. That is the strongest
      // label this module has, over a value that was never read, and with
      // `rowsSkipped=0` the population report says nothing was skipped, so the
      // blindness does not even surface. Azure exports do emit blank cost cells
      // (adjustment and purchase lines, notably).
      //
      // Checked BEFORE coercion, because after `Number()` a blank and a real
      // '0' are the same value and the distinction is unrecoverable.
      if (usdText === undefined || usdText === '') {
        note(
          `${partition.blobName}#${r}`,
          `cost cell is EMPTY (${currencyNote}) — that is NOT MEASURED, not $0.00; ` +
            'refusing to attribute a blank as a zero charge',
        );
        continue;
      }

      const usd = Number(usdText);
      if (!Number.isFinite(usd)) {
        note(`${partition.blobName}#${r}`, `cost value '${usdText}' is not a finite number`);
        continue;
      }

      let nodeId: NodeId;
      try {
        nodeId = azureResourceNodeId(rawId);
      } catch (e) {
        note(
          `${partition.blobName}#${r}`,
          `resource id could not be canonicalised: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      const acc = byResource.get(nodeId);
      if (acc) {
        acc.usd += usd;
        acc.rows += 1;
      } else {
        byResource.set(nodeId, { usd, rows: 1 });
      }
      rowsAttributed += 1;
      if (currencyResolution === null) currencyResolution = currencyNote;
    }
  }

  // Row-count cross-check against the manifest. A name-level match can still
  // hide a truncated blob, so the row count is compared when it is available.
  if (
    completeness === 'complete' &&
    manifestFacts?.dataRowCount !== null &&
    manifestFacts?.dataRowCount !== undefined &&
    manifestFacts.dataRowCount !== rowsExamined
  ) {
    completeness = 'incomplete';
    completenessDetail =
      `every manifest partition was supplied, but the manifest declares ` +
      `${manifestFacts.dataRowCount} data row(s) and ${rowsExamined} were parsed. ` +
      'A blob is truncated or a record was mis-split — this is a PARTIAL read.';
  }

  const asOf = manifestFacts?.asOf ?? null;
  const basisPrefix =
    `Cost Management export '${input.exportName}', ` +
    `schema=${schemaOf(columns)}, completeness=${completeness}` +
    (asOf ? `, run as of ${asOf}` : ', run date NOT ESTABLISHED');

  const figures = new Map<NodeId, BilledFigure>();
  for (const [id, acc] of byResource) {
    // `source` is PINNED, not asserted — same reason as `./derived.ts`.
    // `billedCost` returns the widened `CostFigure` from `../types.ts`, another
    // lane's file, so `as BilledFigure` promised a label it never inspected.
    // This is the channel that MATTERS: `attributeCost` renders anything in
    // `byResource` through the billed path, so a mislabelled figure here is a
    // derived number presented as a bill. Pinning makes the assignment checked
    // against `Map<NodeId, BilledFigure>` — flip this literal and `next build`
    // fails here rather than in a test `tsconfig.build.json` never compiles.
    figures.set(id, {
      ...billedCost(
        acc.usd,
        `${basisPrefix}; ${acc.rows} row(s) summed for this resource. ` +
          'Billed AS OF the export run — a daily export is not a live feed (first data ~24h after creation).',
        asOf ?? ASOF_NOT_ESTABLISHED,
      ),
      source: 'billed' as const,
    });
  }

  return {
    exportName: input.exportName,
    schema: schemaOf(columns),
    columns,
    completeness,
    completenessDetail,
    byResource: figures,
    population: makeReadPopulation({
      subject: 'rows',
      examined: rowsExamined,
      scope: `${input.partitions.length} partition(s) of export '${input.exportName}'`,
    }),
    partitionPopulation,
    rowsAttributed,
    rowsSkipped,
    skipped,
    skippedElided,
    asOf,
    currencyResolution,
  };
}
