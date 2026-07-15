/**
 * DP-8 — the data-product PORTS model (PURE, framework-free).
 *
 * The ODPS/Bitol port model is what distinguishes a mesh data product from a
 * bare dataset: declared **input ports** (upstream dependencies the product
 * consumes), **output ports** (contract-bound interfaces it exposes), and
 * **management ports** (health / observability / control endpoints). Each port
 * is optionally bound 1:many to a data contract. This module is the typed model
 * + sanitizer both the BFF (PATCH/GET) and the Ports designer share; it does no
 * I/O so it is unit-testable and client-safe.
 *
 * Grounding: Bitol ODPS v1.0.0 input/output/management ports
 * (https://bitol-io.github.io/open-data-product-standard/v1.0.0/) + ODCS v3.1.0
 * contract binding per port. Azure-native: input/output refs point at real
 * Azure assets (Synapse table / ADX table / ADLS path / another product's output
 * port) — no Fabric/Power BI dependency (no-fabric-dependency.md).
 */

export type PortDirection = 'input' | 'output' | 'management';
export const PORT_DIRECTIONS: readonly PortDirection[] = ['input', 'output', 'management'];

/** What a port points at. Constrained per direction (see PORT_KINDS_BY_DIRECTION). */
export type PortKind =
  // input sources
  | 'data-product' | 'output-port' | 'synapse-table' | 'adx-table' | 'adls-path'
  // output interfaces
  | 'sql-endpoint' | 'adx' | 'delta' | 'rest'
  // management endpoints
  | 'health' | 'lineage' | 'dq';

/** The valid `kind` values per direction — the picker offers exactly these
 *  (structured, never freeform). */
export const PORT_KINDS_BY_DIRECTION: Readonly<Record<PortDirection, readonly PortKind[]>> = {
  input: ['data-product', 'output-port', 'synapse-table', 'adx-table', 'adls-path'],
  output: ['sql-endpoint', 'adx', 'delta', 'rest'],
  management: ['health', 'lineage', 'dq'],
};

export interface Port {
  /** Stable id (generated when a port is first declared). */
  id: string;
  /** Human label for the port. */
  name: string;
  direction: PortDirection;
  kind: PortKind;
  /** The upstream/downstream reference: a product id, an output-port id, an asset
   *  qualified name, or an ADLS path — resolved by GET .../ports. */
  ref?: string;
  /** Optional bound contract version (output ports; input ports may pin the
   *  upstream contract version they depend on). */
  contractVersion?: string;
  description?: string;
}

export interface PortsModel {
  input: Port[];
  output: Port[];
  management: Port[];
}

export function emptyPorts(): PortsModel {
  return { input: [], output: [], management: [] };
}

function slug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'port';
}

function cleanStr(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Sanitize one raw port into a valid Port, or null when unusable (no name). */
function sanitizePort(raw: unknown, direction: PortDirection, i: number): Port | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = cleanStr(o.name, 120);
  if (!name) return null;
  const allowed = PORT_KINDS_BY_DIRECTION[direction];
  const rawKind = cleanStr(o.kind) as PortKind;
  const kind: PortKind = (allowed as readonly string[]).includes(rawKind) ? rawKind : allowed[0];
  const id = cleanStr(o.id) || `${direction}-${slug(name)}-${i}`;
  const ref = cleanStr(o.ref, 400);
  const contractVersion = cleanStr(o.contractVersion, 40);
  const description = cleanStr(o.description, 500);
  return {
    id, name, direction, kind,
    ...(ref ? { ref } : {}),
    ...(contractVersion ? { contractVersion } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Normalize any incoming ports value to the structured PortsModel. Accepts:
 *   - the structured `{ input[], output[], management[] }` object (DP-8), OR
 *   - the legacy flat `[{ name, direction }]` array (the DP-3 wizard step 4) —
 *     grouped by direction, defaulting to 'output'.
 * Returns a well-formed model with only valid ports.
 */
export function sanitizePorts(raw: unknown): PortsModel {
  const model = emptyPorts();
  if (Array.isArray(raw)) {
    // Legacy flat array from the wizard.
    raw.forEach((p, i) => {
      const dir = (p && typeof p === 'object' && PORT_DIRECTIONS.includes((p as any).direction))
        ? (p as any).direction as PortDirection : 'output';
      const port = sanitizePort(p, dir, i);
      if (port) model[dir].push(port);
    });
    return model;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const dir of PORT_DIRECTIONS) {
      const arr = Array.isArray(o[dir]) ? (o[dir] as unknown[]) : [];
      arr.forEach((p, i) => { const port = sanitizePort(p, dir, i); if (port) model[dir].push(port); });
    }
  }
  return model;
}

export interface PortsSummary { input: number; output: number; management: number; total: number }

export function portsSummary(model: PortsModel): PortsSummary {
  const input = model.input.length, output = model.output.length, management = model.management.length;
  return { input, output, management, total: input + output + management };
}

/** Read a stored ports value off item state (structured or legacy) → model. */
export function readPorts(state: Record<string, unknown> | undefined): PortsModel {
  return sanitizePorts(state?.ports);
}
