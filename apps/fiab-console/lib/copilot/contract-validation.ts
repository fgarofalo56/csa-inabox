/**
 * contract-validation — B-N14c: validate a COPILOT-PROPOSED pipeline / dataflow
 * / SQL against the N6 ODCS data contracts BEFORE the proposal is shown.
 *
 * The N6 contracts already enforce at INGESTION (row-grain quarantine to the
 * Bronze dead-letter path, and `evaluateSchemaConformance` as a pipeline-sink
 * pre-flight). What was missing is the step BEFORE that: a copilot happily
 * proposes a Copy activity, a Power Query step, or an INSERT that will violate a
 * governed contract — the user approves it, and the violation is only discovered
 * at run time in the dead-letter tree. This module closes that loop: the SAME
 * contract, checked against the PROPOSAL, with the violation surfaced in the
 * answer receipt so the user sees it before they click Apply.
 *
 * PURE by construction (no Cosmos / no Azure) so every rule is unit-testable;
 * `contract-guard.ts` is the impure half that loads the real contracts. The
 * write-shape comparison REUSES `evaluateSchemaConformance` from
 * `lib/ingest/contract-rules.ts` verbatim — the proposal's written columns are
 * exactly the "sink columns" that function already grades, so a copilot check
 * and a run-time pre-flight can never disagree.
 *
 * Azure-native only (no-fabric-dependency.md): the proposals graded here target
 * ADF/Synapse pipelines, Power Query dataflows, and Synapse/Azure SQL — no
 * Fabric artifact is required or contacted.
 */

import {
  contractObject,
  evaluateSchemaConformance,
  type RowViolation,
} from '@/lib/ingest/contract-rules';
import {
  DEFAULT_ENFORCEMENT_MODE,
  type DataContractDoc,
  type EnforcementMode,
  type OdcsContract,
} from '@/lib/azure/data-contract-model';

/** What kind of artifact the copilot proposed. */
export type ProposalKind = 'sql' | 'pipeline' | 'dataflow';

/** How the proposal touches a dataset — drives which rules apply. */
export type ProposalAccess = 'write' | 'read';

/** One dataset the proposal touches, with the columns it names. */
export interface ProposalTarget {
  /** Table / dataset / query name as it appears in the proposal. */
  dataset: string;
  access: ProposalAccess;
  /** Columns the proposal writes (access 'write') or reads (access 'read'). */
  columns: string[];
  /** True when the column list is a `SELECT *` / unlisted sink (shape unknown). */
  columnsUnknown?: boolean;
}

/** The copilot proposal handed to the validator. */
export interface CopilotProposal {
  kind: ProposalKind;
  /** SQL text / Power Query M / a human summary — used for target extraction. */
  text?: string;
  /** An ADF/Synapse pipeline spec (`properties.activities[]`). */
  spec?: unknown;
  /** Pre-extracted targets (skips extraction when the caller already knows them). */
  targets?: ProposalTarget[];
}

/** One contract violation found in a proposal. */
export interface ContractProposalViolation {
  /** The contract that was breached. */
  contractId: string;
  contractName: string;
  dataset: string;
  column?: string;
  rule: string;
  severity: 'error' | 'warning' | 'info';
  detail: string;
}

/** The verdict for ONE proposal, rendered in the answer receipt. */
export interface ContractCheckResult {
  /** True when nothing error-severity was found. */
  ok: boolean;
  /**
   * True when a `hard-reject` contract found an error — the proposal MUST NOT be
   * applied as-is. `warn-quarantine` (the default) never blocks.
   */
  blocked: boolean;
  kind: ProposalKind;
  /** Contracts that actually governed a target of this proposal. */
  contractsChecked: Array<{ id: string; name: string; version?: string; status?: string; mode: EnforcementMode }>;
  /** Datasets the proposal touches that NO contract governs (informational). */
  ungovernedDatasets: string[];
  violations: ContractProposalViolation[];
  /** One-line operator summary rendered on the receipt badge. */
  note: string;
}

// ── Target extraction ──────────────────────────────────────────────────────

/** Strip SQL comments + string literals so identifier matching can't be fooled. */
function stripSqlNoise(sql: string): string {
  return String(sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, " '' ");
}

/** Normalize a possibly-bracketed/quoted SQL identifier to its bare last part. */
export function bareIdentifier(raw: string): string {
  const s = String(raw || '').trim().replace(/;$/, '');
  if (!s) return '';
  const parts = s.split('.');
  const last = parts[parts.length - 1] || '';
  return last.replace(/^[[`"]+/, '').replace(/[\]`"]+$/, '').trim();
}

/** Split a parenthesised column list into bare column names. */
function splitColumnList(list: string): string[] {
  // NOTE: trim BEFORE splitting on whitespace — `', amount'.split(/\s+/)[0]` is
  // the empty string, which silently dropped every column after the first.
  return list
    .split(',')
    .map((c) => bareIdentifier(c.trim().split(/\s+/)[0] || ''))
    .filter((c) => c && !/^\(/.test(c));
}

/**
 * Extract the datasets + columns a T-SQL proposal touches. Deliberately
 * conservative: only forms we can read with confidence produce a target, and a
 * `SELECT *` / unlisted INSERT marks `columnsUnknown` rather than guessing.
 */
export function extractSqlTargets(sql: string): ProposalTarget[] {
  const text = stripSqlNoise(sql);
  const byKey = new Map<string, ProposalTarget>();
  const add = (dataset: string, access: ProposalAccess, columns: string[], unknown = false) => {
    const name = bareIdentifier(dataset);
    if (!name) return;
    const key = `${name.toLowerCase()}|${access}`;
    const prior = byKey.get(key);
    if (prior) {
      for (const c of columns) if (!prior.columns.some((x) => x.toLowerCase() === c.toLowerCase())) prior.columns.push(c);
      if (unknown) prior.columnsUnknown = true;
      return;
    }
    byKey.set(key, { dataset: name, access, columns: [...new Set(columns)], ...(unknown ? { columnsUnknown: true } : {}) });
  };

  // INSERT INTO <t> (c1, c2, …)
  for (const m of text.matchAll(/\bINSERT\s+INTO\s+([A-Za-z0-9_.[\]`"]+)\s*(\(([^)]*)\))?/gi)) {
    add(m[1], 'write', m[3] ? splitColumnList(m[3]) : [], !m[3]);
  }
  // CREATE TABLE <t> (c1 type, c2 type, …)
  for (const m of text.matchAll(/\bCREATE\s+(?:OR\s+ALTER\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_.[\]`"]+)\s*\(([\s\S]*?)\)\s*(?:;|$|WITH)/gi)) {
    add(m[1], 'write', splitColumnList(m[2]));
  }
  // UPDATE <t> SET c1 = …, c2 = …
  for (const m of text.matchAll(/\bUPDATE\s+([A-Za-z0-9_.[\]`"]+)\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bFROM\b|;|$)/gi)) {
    const cols = m[2].split(',').map((a) => bareIdentifier((a.split('=')[0] || '').trim())).filter(Boolean);
    add(m[1], 'write', cols);
  }
  // MERGE INTO <t>
  for (const m of text.matchAll(/\bMERGE\s+INTO\s+([A-Za-z0-9_.[\]`"]+)/gi)) add(m[1], 'write', [], true);

  // SELECT <cols> FROM <t> [JOIN <t2>] — read access (governs sensitive columns).
  for (const m of text.matchAll(/\bSELECT\s+([\s\S]*?)\bFROM\s+([A-Za-z0-9_.[\]`"]+)/gi)) {
    const raw = m[1].trim();
    const star = /(^|[\s,.])\*/.test(raw);
    const cols = star
      ? []
      : raw
          .split(',')
          .map((c) => bareIdentifier(c.trim().split(/\s+AS\s+|\s+/i)[0] || ''))
          .filter(Boolean);
    add(m[2], 'read', cols, star);
  }
  for (const m of text.matchAll(/\bJOIN\s+([A-Za-z0-9_.[\]`"]+)/gi)) add(m[1], 'read', [], true);

  return [...byKey.values()];
}

/** Shape of the pipeline activities we can read a sink/source dataset out of. */
interface ActivityLike {
  name?: unknown;
  type?: unknown;
  inputs?: Array<{ referenceName?: unknown }>;
  outputs?: Array<{ referenceName?: unknown }>;
  typeProperties?: {
    sink?: { tableName?: unknown; table?: unknown; type?: unknown };
    source?: { tableName?: unknown; table?: unknown; sqlReaderQuery?: unknown; query?: unknown };
    translator?: { mappings?: Array<{ sink?: { name?: unknown } }> };
    script?: unknown;
    scripts?: Array<{ text?: unknown }>;
  };
}

/**
 * Extract targets from an ADF / Synapse pipeline spec: Copy sinks (with their
 * column mappings when a translator is declared) and Copy sources. Any embedded
 * SQL (`sqlReaderQuery`, Script activity text) is ALSO run through the SQL
 * extractor, so a contract breach hidden inside a query string still surfaces.
 */
export function extractPipelineTargets(spec: unknown): ProposalTarget[] {
  const out: ProposalTarget[] = [];
  const activities =
    (spec as { properties?: { activities?: unknown } } | null)?.properties?.activities;
  if (!Array.isArray(activities)) return out;
  for (const rawAct of activities) {
    const a = rawAct as ActivityLike;
    const tp = a?.typeProperties || {};
    const sinkTable = String(tp.sink?.tableName ?? tp.sink?.table ?? '');
    const outRef = String(a?.outputs?.[0]?.referenceName ?? '');
    const sinkName = sinkTable || outRef;
    if (sinkName) {
      const mapped = (tp.translator?.mappings || [])
        .map((mp) => String(mp?.sink?.name ?? ''))
        .filter(Boolean);
      out.push({
        dataset: bareIdentifier(sinkName),
        access: 'write',
        columns: mapped,
        ...(mapped.length ? {} : { columnsUnknown: true }),
      });
    }
    const srcTable = String(tp.source?.tableName ?? tp.source?.table ?? '');
    const inRef = String(a?.inputs?.[0]?.referenceName ?? '');
    const srcName = srcTable || inRef;
    if (srcName) out.push({ dataset: bareIdentifier(srcName), access: 'read', columns: [], columnsUnknown: true });

    const embedded = [
      String(tp.source?.sqlReaderQuery ?? ''),
      String(tp.source?.query ?? ''),
      String(tp.script ?? ''),
      ...(tp.scripts || []).map((s) => String(s?.text ?? '')),
    ].filter((s) => s.trim());
    for (const sql of embedded) out.push(...extractSqlTargets(sql));
  }
  return out;
}

/**
 * Extract targets from a Power Query (M) proposal. M is not SQL, so only the
 * forms that name a real table/columns are read: `Sql.Database(...,[Query=…])`
 * (delegated to the SQL extractor), `Table.SelectColumns`, `Table.RemoveColumns`,
 * and the `Item="<table>"` / `Name="<table>"` navigation step.
 */
export function extractDataflowTargets(m: string): ProposalTarget[] {
  const text = String(m || '');
  const out: ProposalTarget[] = [];
  for (const q of text.matchAll(/\[\s*Query\s*=\s*"((?:[^"]|"")*)"/gi)) {
    out.push(...extractSqlTargets(q[1].replace(/""/g, '"')));
  }
  const tables = new Set<string>();
  for (const m2 of text.matchAll(/\b(?:Item|Name)\s*=\s*"([^"]{1,120})"/g)) tables.add(bareIdentifier(m2[1]));
  const selected = new Set<string>();
  for (const m3 of text.matchAll(/Table\.(?:SelectColumns|RemoveColumns)\s*\([^,]+,\s*\{([^}]*)\}/g)) {
    for (const c of m3[1].split(',')) {
      const name = c.trim().replace(/^"/, '').replace(/"$/, '').trim();
      if (name) selected.add(name);
    }
  }
  for (const t of tables) {
    out.push({
      dataset: t,
      access: 'read',
      columns: [...selected],
      ...(selected.size ? {} : { columnsUnknown: true }),
    });
  }
  return out;
}

/** Extract every target of a proposal (explicit targets win). */
export function extractProposalTargets(proposal: CopilotProposal): ProposalTarget[] {
  if (proposal.targets?.length) return proposal.targets;
  if (proposal.kind === 'pipeline') return extractPipelineTargets(proposal.spec);
  if (proposal.kind === 'dataflow') return extractDataflowTargets(proposal.text || '');
  return extractSqlTargets(proposal.text || '');
}

// ── Contract matching ──────────────────────────────────────────────────────

/** Every dataset name a contract governs (binding datasets + ODCS object names). */
export function contractDatasetNames(doc: DataContractDoc): string[] {
  const names = new Set<string>();
  for (const b of doc.bindings || []) {
    const d = bareIdentifier(String(b.dataset || ''));
    if (d) names.add(d.toLowerCase());
  }
  for (const obj of doc.odcs?.schema || []) {
    if (obj.name) names.add(bareIdentifier(obj.name).toLowerCase());
    if (obj.physicalName) names.add(bareIdentifier(obj.physicalName).toLowerCase());
  }
  return [...names];
}

/** True when `target` names a dataset this contract governs. */
export function contractGoverns(doc: DataContractDoc, target: ProposalTarget): boolean {
  const name = bareIdentifier(target.dataset).toLowerCase();
  if (!name) return false;
  return contractDatasetNames(doc).includes(name);
}

/** Enforcement mode of a contract, defaulting SAFELY (`warn-quarantine`). */
function modeOf(doc: DataContractDoc): EnforcementMode {
  return doc.enforcement?.mode || DEFAULT_ENFORCEMENT_MODE;
}

/** Contracted columns whose ODCS `classification` marks them sensitive. */
function classifiedColumns(odcs: OdcsContract | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const obj = contractObject(odcs);
  for (const p of obj?.properties || []) {
    if (p.classification && String(p.classification).trim()) out.set(p.name.toLowerCase(), String(p.classification));
  }
  return out;
}

/** REQUIRED contracted columns (ODCS `required` / `primaryKey`). */
function requiredColumns(odcs: OdcsContract | undefined): string[] {
  const obj = contractObject(odcs);
  return (obj?.properties || []).filter((p) => p.required || p.primaryKey).map((p) => p.name);
}

/** Map a shared {@link RowViolation} onto the proposal-violation shape. */
function fromRowViolation(
  v: RowViolation, doc: DataContractDoc, dataset: string,
): ContractProposalViolation {
  return {
    contractId: doc.itemId,
    contractName: doc.displayName || doc.itemId,
    dataset,
    column: v.column,
    rule: v.rule,
    severity: v.severity,
    detail: v.detail,
  };
}

/**
 * Grade one proposal against the contracts that govern its targets.
 *
 * PURE. Rules, in the order they fire:
 *   • WRITE with a known column list → `evaluateSchemaConformance` (the SAME
 *     function the run-time pipeline-sink pre-flight uses): a contracted column
 *     absent from the write = error; an undeclared written column = drift warning.
 *   • WRITE with an UNKNOWN column list → an info row naming the required
 *     columns the proposal must carry (never an error — we do not know it fails).
 *   • READ of a classified column → a governance warning naming the
 *     classification, so a copilot-proposed SELECT over PII is visible.
 *   • A contract whose status is `deprecated` / `retired` → warning.
 *   • `hard-reject` mode + any error → `blocked: true`.
 */
export function validateProposal(
  proposal: CopilotProposal,
  contracts: readonly DataContractDoc[],
): ContractCheckResult {
  const targets = extractProposalTargets(proposal);
  const violations: ContractProposalViolation[] = [];
  const checked = new Map<string, ContractCheckResult['contractsChecked'][number]>();
  const ungoverned = new Set<string>();
  let blocked = false;

  for (const t of targets) {
    const governing = contracts.filter(
      (d) => d.enforcement?.enabled !== false && contractGoverns(d, t),
    );
    if (!governing.length) {
      if (t.dataset) ungoverned.add(t.dataset);
      continue;
    }
    for (const doc of governing) {
      const mode = modeOf(doc);
      checked.set(doc.itemId, {
        id: doc.itemId,
        name: doc.displayName || doc.itemId,
        version: doc.odcs?.version,
        status: doc.odcs?.status,
        mode,
      });

      const status = String(doc.odcs?.status || '').toLowerCase();
      if (status === 'deprecated' || status === 'retired') {
        violations.push({
          contractId: doc.itemId,
          contractName: doc.displayName || doc.itemId,
          dataset: t.dataset,
          rule: 'contractNotActive',
          severity: 'warning',
          detail: `The contract governing '${t.dataset}' is ${status}. Confirm this dataset is still the right target before applying the proposal.`,
        });
      }

      if (t.access === 'write') {
        if (t.columnsUnknown || t.columns.length === 0) {
          const req = requiredColumns(doc.odcs);
          violations.push({
            contractId: doc.itemId,
            contractName: doc.displayName || doc.itemId,
            dataset: t.dataset,
            rule: 'writeShapeUnknown',
            severity: 'info',
            detail: req.length
              ? `The proposal writes to contracted '${t.dataset}' without naming its columns. The contract requires: ${req.join(', ')}.`
              : `The proposal writes to contracted '${t.dataset}' without naming its columns, so its shape could not be graded before the run.`,
          });
          continue;
        }
        // The SAME grader the run-time pipeline-sink pre-flight uses.
        const conf = evaluateSchemaConformance(
          doc.odcs,
          t.columns.map((c) => ({ name: c })),
          mode,
        );
        for (const v of conf.violations) violations.push(fromRowViolation(v, doc, t.dataset));
        if (conf.blocked) blocked = true;
        continue;
      }

      // READ — surface classified columns the proposal would expose.
      const classified = classifiedColumns(doc.odcs);
      if (!classified.size) continue;
      const exposed = t.columnsUnknown
        ? [...classified.keys()]
        : t.columns.filter((c) => classified.has(c.toLowerCase())).map((c) => c.toLowerCase());
      for (const col of new Set(exposed)) {
        violations.push({
          contractId: doc.itemId,
          contractName: doc.displayName || doc.itemId,
          dataset: t.dataset,
          column: col,
          rule: t.columnsUnknown ? 'classifiedColumnMayBeExposed' : 'classifiedColumnExposed',
          severity: 'warning',
          detail: t.columnsUnknown
            ? `The proposal reads all columns of '${t.dataset}', which includes '${col}' classified as ${classified.get(col)}. Project only the columns you need.`
            : `The proposal reads '${col}' from '${t.dataset}', classified as ${classified.get(col)}.`,
        });
      }
    }
  }

  const errors = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity === 'warning');
  const contractsChecked = [...checked.values()];

  const note = !contractsChecked.length
    ? targets.length
      ? `No data contract governs ${targets.length === 1 ? 'this target' : 'these targets'} — nothing to check.`
      : 'No dataset could be read out of this proposal, so no contract check ran.'
    : blocked
      ? `BLOCKED: ${errors.length} contract error(s) against a hard-reject contract. Applying this proposal would fail the run before any data moved.`
      : errors.length
        ? `${errors.length} contract error(s) found. The bound contract is in warn-quarantine mode, so a run would land with the violating rows quarantined — fix the proposal first.`
        : warnings.length
          ? `Conforms to ${contractsChecked.length} contract(s); ${warnings.length} governance warning(s) to review.`
          : `Conforms to ${contractsChecked.length} governing contract(s).`;

  return {
    ok: errors.length === 0,
    blocked,
    kind: proposal.kind,
    contractsChecked,
    ungovernedDatasets: [...ungoverned],
    violations,
    note,
  };
}
