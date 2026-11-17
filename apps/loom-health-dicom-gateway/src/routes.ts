// Route grammar for the gateway's DICOMweb surface. The gateway is an allowlist:
// a path that does not parse here never reaches the archive, so none of the
// archive's other endpoints (admin, export, UPS, bulk update) are reachable.
//
//   /{tenant}/dicomweb/v1/<dicomweb path>
//
// `interaction` is the PDP vocabulary (data.lhds.interactions.dicom): wado, qido,
// stow, delete. Everything W03b owns (changefeed, extended query tags, partitions,
// delete) is deliberately NOT routed here.

import { SLUG } from './slug.js';

export type Interaction = 'wado' | 'qido' | 'stow';

export interface Route {
  tenant: string;
  interaction: Interaction;
  /** Archive path below `/rs`, already validated, no query string. */
  archivePath: string;
}

export type RouteResult =
  | { ok: true; route: Route }
  | { ok: false; status: 404 | 405; reason: string; allow?: string };

// DICOM UI: digits and dots, max 64 chars, no empty components.
const UID = /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))*$/;
const FRAMES = /^[1-9][0-9]*(?:,[1-9][0-9]*)*$/;

function isUid(s: string | undefined): s is string {
  return s !== undefined && s.length <= 64 && UID.test(s);
}

const COLLECTIONS = new Set(['studies', 'series', 'instances']);
const WADO_SUFFIX = new Set(['metadata', 'rendered', 'thumbnail']);

function classify(method: string, seg: string[]): Interaction | null {
  const n = seg.length;
  if (n === 0) return null;

  if (method === 'POST') {
    if (n === 1 && seg[0] === 'studies') return 'stow';
    if (n === 2 && seg[0] === 'studies' && isUid(seg[1])) return 'stow';
    return null;
  }
  if (method !== 'GET' && method !== 'HEAD') return null;

  // QIDO: collection searches.
  if (n === 1 && COLLECTIONS.has(seg[0]!)) return 'qido';
  if (seg[0] !== 'studies' || !isUid(seg[1])) return null;
  if (n === 2) return 'wado'; // study
  if (n === 3 && (seg[2] === 'series' || seg[2] === 'instances')) return 'qido';
  if (n === 3 && WADO_SUFFIX.has(seg[2]!)) return 'wado';
  if (seg[2] !== 'series' || !isUid(seg[3])) return null;
  if (n === 4) return 'wado'; // series
  if (n === 5 && seg[4] === 'instances') return 'qido';
  if (n === 5 && WADO_SUFFIX.has(seg[4]!)) return 'wado';
  if (seg[4] !== 'instances' || !isUid(seg[5])) return null;
  if (n === 6) return 'wado'; // instance
  if (n === 7 && WADO_SUFFIX.has(seg[6]!)) return 'wado';
  if (seg[6] === 'frames' && FRAMES.test(seg[7] ?? '')) {
    if (n === 8) return 'wado';
    if (n === 9 && seg[8] === 'rendered') return 'wado';
  }
  return null;
}

export function parseRoute(method: string, pathname: string, archiveAet: string): RouteResult {
  // Encoded separators / dot-segments would survive to the archive: reject first.
  if (/%(2e|2f|5c|00)/i.test(pathname) || pathname.includes('\\') || pathname.includes('\0')) {
    return { ok: false, status: 404, reason: 'not-found' };
  }
  const parts = pathname.split('/');
  // ['', tenant, 'dicomweb', 'v1', ...rest]
  if (parts[0] !== '' || parts.length < 5 || parts[2] !== 'dicomweb' || parts[3] !== 'v1') {
    return { ok: false, status: 404, reason: 'not-found' };
  }
  const tenant = parts[1]!;
  if (!SLUG.test(tenant)) return { ok: false, status: 404, reason: 'not-found' };
  const rest = parts.slice(4);
  if (rest.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, status: 404, reason: 'not-found' };
  }
  const interaction = classify(method, rest);
  if (!interaction) {
    if (COLLECTIONS.has(rest[0]!) && !['GET', 'HEAD', 'POST'].includes(method)) {
      return { ok: false, status: 405, reason: 'method-not-allowed', allow: 'GET, HEAD, POST' };
    }
    return { ok: false, status: 404, reason: 'not-found' };
  }
  return {
    ok: true,
    route: {
      tenant,
      interaction,
      archivePath: `/dcm4chee-arc/aets/${encodeURIComponent(archiveAet)}/rs/${rest.join('/')}`,
    },
  };
}
