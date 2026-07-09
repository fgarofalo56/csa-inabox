/**
 * Curated Real-Time Hub sample streams (FGC-14) — Fabric parity.
 *
 * Fabric's "Sample data" source offers a NAMED catalog of built-in streams
 * (Bicycles / Yellow Taxi / Stock Market / Buses / S&P 500 / Semantic Model
 * Logs), not a free-text box. This module is that catalog plus a PURE event
 * generator so the dropdown can produce a LIVE stream — the generated events
 * are posted to an Event Hub by the sample route (Azure-native; no Fabric).
 *
 * Source: https://learn.microsoft.com/fabric/real-time-hub/supported-sources
 *
 * The generator is deterministic given a seed (for tests) and otherwise draws
 * from Math.random — every event is a plain JSON object matching the stream's
 * documented schema, ready to land as an Event Hub message.
 */

export interface SampleStreamField {
  name: string;
  /** Loose type hint for the schema preview. */
  type: 'string' | 'number' | 'integer' | 'boolean' | 'datetime';
}

export interface SampleStream {
  /** Stable id used as the connector's `sampleType` value + route param. */
  id: string;
  /** Fabric-facing display name. */
  label: string;
  description: string;
  /** Documented event schema (drives the schema preview + generator output). */
  schema: SampleStreamField[];
  /** Suggested events-per-second for the live preview. */
  defaultRate: number;
}

export const CURATED_SAMPLE_STREAMS: SampleStream[] = [
  {
    id: 'Bicycles',
    label: 'Bicycles',
    description: 'London cycle-hire dock availability — bikes/empty docks per station, refreshed continuously.',
    defaultRate: 5,
    schema: [
      { name: 'BikepointID', type: 'string' },
      { name: 'Street', type: 'string' },
      { name: 'Neighbourhood', type: 'string' },
      { name: 'Latitude', type: 'number' },
      { name: 'Longitude', type: 'number' },
      { name: 'No_Bikes', type: 'integer' },
      { name: 'No_Empty_Docks', type: 'integer' },
      { name: 'Timestamp', type: 'datetime' },
    ],
  },
  {
    id: 'YellowTaxi',
    label: 'Yellow Taxi',
    description: 'NYC yellow-taxi trips — pickup/dropoff, distance, fare and passenger count.',
    defaultRate: 10,
    schema: [
      { name: 'tripId', type: 'string' },
      { name: 'vendorId', type: 'integer' },
      { name: 'pickupTime', type: 'datetime' },
      { name: 'dropoffTime', type: 'datetime' },
      { name: 'passengerCount', type: 'integer' },
      { name: 'tripDistance', type: 'number' },
      { name: 'fareAmount', type: 'number' },
      { name: 'tipAmount', type: 'number' },
    ],
  },
  {
    id: 'StockMarket',
    label: 'Stock Market',
    description: 'Simulated equity ticks — symbol, price, bid/ask and traded volume.',
    defaultRate: 20,
    schema: [
      { name: 'symbol', type: 'string' },
      { name: 'price', type: 'number' },
      { name: 'bid', type: 'number' },
      { name: 'ask', type: 'number' },
      { name: 'volume', type: 'integer' },
      { name: 'timestamp', type: 'datetime' },
    ],
  },
  {
    id: 'Buses',
    label: 'Buses',
    description: 'Transit-bus telemetry — line, position, delay against schedule and passenger load.',
    defaultRate: 8,
    schema: [
      { name: 'busId', type: 'string' },
      { name: 'lineRef', type: 'string' },
      { name: 'latitude', type: 'number' },
      { name: 'longitude', type: 'number' },
      { name: 'delaySeconds', type: 'integer' },
      { name: 'occupancy', type: 'string' },
      { name: 'timestamp', type: 'datetime' },
    ],
  },
  {
    id: 'SP500',
    label: 'S&P 500',
    description: 'S&P 500 constituents — company, sector, last price and daily change.',
    defaultRate: 15,
    schema: [
      { name: 'symbol', type: 'string' },
      { name: 'company', type: 'string' },
      { name: 'sector', type: 'string' },
      { name: 'price', type: 'number' },
      { name: 'changePercent', type: 'number' },
      { name: 'timestamp', type: 'datetime' },
    ],
  },
  {
    id: 'SemanticModelLogs',
    label: 'Semantic Model Logs',
    description: 'Semantic-model query telemetry — operation, duration, rows and outcome.',
    defaultRate: 6,
    schema: [
      { name: 'modelId', type: 'string' },
      { name: 'operation', type: 'string' },
      { name: 'durationMs', type: 'integer' },
      { name: 'rowCount', type: 'integer' },
      { name: 'status', type: 'string' },
      { name: 'user', type: 'string' },
      { name: 'timestamp', type: 'datetime' },
    ],
  },
];

/** Resolve a curated stream by id. */
export function sampleStreamById(id: string): SampleStream | undefined {
  return CURATED_SAMPLE_STREAMS.find((s) => s.id === id);
}

/** The dropdown options for the Sample-data connector's `sampleType` field. */
export function sampleStreamOptions(): Array<{ value: string; label: string }> {
  return CURATED_SAMPLE_STREAMS.map((s) => ({ value: s.id, label: s.label }));
}

// ── deterministic PRNG so tests can assert exact generated events ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NEIGHBOURHOODS = ['Camden', 'Hackney', 'Islington', 'Southwark', 'Westminster'];
const SECTORS = ['Technology', 'Financials', 'Health Care', 'Energy', 'Industrials'];
const OCCUPANCY = ['empty', 'seatsAvailable', 'standingRoomOnly', 'full'];
const STATUSES = ['success', 'success', 'success', 'timeout', 'error'];

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Generate `count` events for a curated stream. Pure given a seed (deterministic
 * for tests); each event is a JSON object matching the stream's schema, ready to
 * publish to an Event Hub. Timestamps anchor to `now` (default Date.now()).
 */
export function generateSampleEvents(
  streamId: string,
  count: number,
  opts: { seed?: number; now?: number } = {},
): Array<Record<string, unknown>> {
  const stream = sampleStreamById(streamId);
  if (!stream) throw new Error(`unknown sample stream '${streamId}'`);
  const n = Math.max(0, Math.min(1000, Math.floor(count)));
  const rand = mulberry32(opts.seed ?? 0x9e3779b9);
  const baseTime = opts.now ?? Date.now();
  const iso = (offsetMs: number) => new Date(baseTime + offsetMs).toISOString();
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const out: Array<Record<string, unknown>> = [];

  for (let i = 0; i < n; i++) {
    switch (streamId) {
      case 'Bicycles':
        out.push({
          BikepointID: `BikePoints_${100 + Math.floor(rand() * 800)}`,
          Street: `Street ${Math.floor(rand() * 200)}`,
          Neighbourhood: pick(NEIGHBOURHOODS),
          Latitude: round(51.5 + rand() * 0.1, 5),
          Longitude: round(-0.12 + rand() * 0.1, 5),
          No_Bikes: Math.floor(rand() * 30),
          No_Empty_Docks: Math.floor(rand() * 30),
          Timestamp: iso(i * 200),
        });
        break;
      case 'YellowTaxi': {
        const dist = round(0.5 + rand() * 20);
        out.push({
          tripId: `trip-${baseTime}-${i}`,
          vendorId: 1 + Math.floor(rand() * 2),
          pickupTime: iso(i * 100),
          dropoffTime: iso(i * 100 + Math.floor(rand() * 1_800_000)),
          passengerCount: 1 + Math.floor(rand() * 4),
          tripDistance: dist,
          fareAmount: round(2.5 + dist * 2.5),
          tipAmount: round(rand() * 8),
        });
        break;
      }
      case 'StockMarket': {
        const price = round(10 + rand() * 490);
        out.push({
          symbol: pick(['MSFT', 'AAPL', 'AMZN', 'GOOGL', 'NVDA']),
          price,
          bid: round(price - rand()),
          ask: round(price + rand()),
          volume: Math.floor(rand() * 100000),
          timestamp: iso(i * 50),
        });
        break;
      }
      case 'Buses':
        out.push({
          busId: `bus-${1000 + Math.floor(rand() * 500)}`,
          lineRef: `${1 + Math.floor(rand() * 99)}`,
          latitude: round(51.5 + rand() * 0.1, 5),
          longitude: round(-0.12 + rand() * 0.1, 5),
          delaySeconds: Math.floor(rand() * 600) - 120,
          occupancy: pick(OCCUPANCY),
          timestamp: iso(i * 150),
        });
        break;
      case 'SP500': {
        const price = round(20 + rand() * 800);
        out.push({
          symbol: pick(['MSFT', 'AAPL', 'JPM', 'XOM', 'UNH']),
          company: pick(['Microsoft', 'Apple', 'JPMorgan', 'Exxon Mobil', 'UnitedHealth']),
          sector: pick(SECTORS),
          price,
          changePercent: round(rand() * 6 - 3),
          timestamp: iso(i * 120),
        });
        break;
      }
      case 'SemanticModelLogs':
        out.push({
          modelId: `model-${1 + Math.floor(rand() * 12)}`,
          operation: pick(['QueryData', 'RefreshModel', 'EvaluateMeasure', 'DiscoverColumns']),
          durationMs: Math.floor(rand() * 5000),
          rowCount: Math.floor(rand() * 100000),
          status: pick(STATUSES),
          user: `user${Math.floor(rand() * 50)}@contoso.com`,
          timestamp: iso(i * 130),
        });
        break;
      default:
        out.push({ seq: i, timestamp: iso(i * 100) });
    }
  }
  return out;
}
