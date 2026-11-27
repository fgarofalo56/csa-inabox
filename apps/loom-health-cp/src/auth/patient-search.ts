// Patient search for the standalone patient picker (#5454 A5). The picker never
// searches with the AS's own authority: every call carries an access token the
// AS minted for the SIGNED-IN user (60 s, `user/Patient.rs` intersected with
// that user's role ceilings), so the tenant FHIR engine and the PDP decide what
// the user may see. Failure is honest: an unreachable or failing FHIR endpoint
// throws PatientSearchUnavailableError and the picker says so. It never returns
// an invented patient.

import { FHIR_ID } from './fhir-user.js';

export interface PatientSummary {
  id: string;
  name: string;
  birthDate?: string;
  gender?: string;
}

export interface PatientQuery {
  name: string;
  /** FHIR date (YYYY, YYYY-MM or YYYY-MM-DD). */
  birthdate?: string;
}

export interface PatientSearch {
  /** At most PATIENT_SEARCH_MAX patients the user may see. Throws PatientSearchUnavailableError on any FHIR failure. */
  search(tenant: string, oid: string, roles: readonly string[], query: PatientQuery): Promise<PatientSummary[]>;
  /** The patient when it exists AND this user may read it; undefined otherwise. Throws PatientSearchUnavailableError. */
  read(tenant: string, oid: string, roles: readonly string[], id: string): Promise<PatientSummary | undefined>;
}

/**
 * Why a FHIR request produced no HTTP response. Fixed classes only; the URL, token and body never appear.
 *   tls      the server certificate was rejected (untrusted, self-signed, expired, wrong host)
 *   dns      the host name did not resolve
 *   refused  the TCP connection was refused
 *   reset    the connection was reset
 *   timeout  no answer before the deadline
 *   network  any other failure before a response
 */
export type FetchFailureClass = 'tls' | 'dns' | 'refused' | 'reset' | 'timeout' | 'network';

const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_CHAIN_TOO_LONG',
  'INVALID_CA',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EPROTO',
]);
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

/** The first well-formed error code on the error, its cause chain, or an AggregateError's members. */
export function fetchErrorCode(e: unknown, depth = 0): string | undefined {
  if (!e || typeof e !== 'object' || depth > 4) return undefined;
  const o = e as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof o.code === 'string' && ERROR_CODE.test(o.code)) return o.code;
  const fromCause = fetchErrorCode(o.cause, depth + 1);
  if (fromCause) return fromCause;
  if (Array.isArray(o.errors)) {
    for (const x of o.errors) {
      const c = fetchErrorCode(x, depth + 1);
      if (c) return c;
    }
  }
  return undefined;
}

/** Map a rejected fetch to a fixed class plus the error code (when one is present). */
export function classifyFetchFailure(e: unknown): { kind: FetchFailureClass; code?: string } {
  const name = e instanceof Error || (e && typeof e === 'object') ? (e as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout' };
  const code = fetchErrorCode(e);
  const withCode = <K extends FetchFailureClass>(kind: K) => (code ? { kind, code } : { kind });
  if (!code) return { kind: 'network' };
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return withCode('timeout');
  if (TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) return withCode('tls');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return withCode('dns');
  if (code === 'ECONNREFUSED') return withCode('refused');
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return withCode('reset');
  return withCode('network');
}

export class PatientSearchUnavailableError extends Error {
  /** Set when the request produced no HTTP response. */
  readonly kind?: FetchFailureClass;
  readonly code?: string;

  constructor(readonly reason: string, failure?: { kind: FetchFailureClass; code?: string }) {
    super(`patient search unavailable: ${reason}`);
    this.name = 'PatientSearchUnavailableError';
    if (failure) {
      this.kind = failure.kind;
      if (failure.code) this.code = failure.code;
    }
  }

  /** reason = `<class>` or `<class> <CODE>`, e.g. "tls DEPTH_ZERO_SELF_SIGNED_CERT". Logged as-is by the AS. */
  static fromFetchFailure(e: unknown): PatientSearchUnavailableError {
    const f = classifyFetchFailure(e);
    return new PatientSearchUnavailableError(f.code ? `${f.kind} ${f.code}` : f.kind, f);
  }
}

export const PATIENT_SEARCH_MAX = 20;
export const PATIENT_SEARCH_TIMEOUT_MS = 5000;
export const FHIR_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const GENDERS = new Set(['male', 'female', 'other', 'unknown']);
const NAME_MAX = 200;

/** One display name from a FHIR Patient; '' when none is recorded. Exported for tests. */
export function patientName(r: Record<string, unknown>): string {
  const names = Array.isArray(r.name) ? (r.name as Array<Record<string, unknown>>) : [];
  const n = names.find((x) => x && x.use === 'official') ?? names[0];
  if (!n || typeof n !== 'object') return '';
  if (typeof n.text === 'string' && n.text.trim()) return n.text.trim().slice(0, NAME_MAX);
  const given = Array.isArray(n.given) ? (n.given as unknown[]).filter((g): g is string => typeof g === 'string') : [];
  const family = typeof n.family === 'string' ? [n.family] : [];
  return [...given, ...family].join(' ').trim().slice(0, NAME_MAX);
}

/** A Patient resource as a summary; undefined for anything that is not a Patient with a valid id. */
export function summarize(r: unknown): PatientSummary | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const o = r as Record<string, unknown>;
  if (o.resourceType !== 'Patient' || typeof o.id !== 'string' || !FHIR_ID.test(o.id)) return undefined;
  const out: PatientSummary = { id: o.id, name: patientName(o) };
  if (typeof o.birthDate === 'string' && FHIR_DATE.test(o.birthDate)) out.birthDate = o.birthDate;
  if (typeof o.gender === 'string' && GENDERS.has(o.gender)) out.gender = o.gender;
  return out;
}

export interface FhirPatientSearchOptions {
  fhirBaseFor: (tenant: string) => string;
  /** A user access token for the FHIR base: the AS mints it (server.ts). */
  token: (tenant: string, oid: string, roles: readonly string[]) => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The default PatientSearch: FHIR REST at the tenant base, as the user. */
export function createFhirPatientSearch(o: FhirPatientSearchOptions): PatientSearch {
  const fetchImpl = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? PATIENT_SEARCH_TIMEOUT_MS;

  async function get(tenant: string, oid: string, roles: readonly string[], url: string): Promise<{ status: number; body: unknown }> {
    const bearer = await o.token(tenant, oid, roles);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/fhir+json', authorization: `Bearer ${bearer}` },
      });
    } catch (e) {
      // No HTTP response. Say WHICH failure (R7): a rejected certificate is not "did not respond".
      throw PatientSearchUnavailableError.fromFetchFailure(e);
    }
    let body: unknown;
    try {
      body = res.ok ? await res.json() : undefined;
    } catch {
      throw new PatientSearchUnavailableError('response was not JSON');
    }
    return { status: res.status, body };
  }

  return {
    async search(tenant, oid, roles, query) {
      const q = new URLSearchParams({ name: query.name, _count: String(PATIENT_SEARCH_MAX) });
      if (query.birthdate) q.set('birthdate', query.birthdate);
      const r = await get(tenant, oid, roles, `${o.fhirBaseFor(tenant)}/Patient?${q}`);
      if (r.status < 200 || r.status > 299) throw new PatientSearchUnavailableError(`HTTP ${r.status}`);
      const b = r.body as { resourceType?: unknown; entry?: unknown } | undefined;
      if (!b || b.resourceType !== 'Bundle') throw new PatientSearchUnavailableError('response was not a Bundle');
      const entries = Array.isArray(b.entry) ? (b.entry as Array<{ resource?: unknown; search?: { mode?: unknown } }>) : [];
      const out: PatientSummary[] = [];
      for (const e of entries) {
        if (e?.search?.mode === 'include' || e?.search?.mode === 'outcome') continue;
        const s = summarize(e?.resource);
        if (s) out.push(s);
        if (out.length >= PATIENT_SEARCH_MAX) break;
      }
      return out;
    },
    async read(tenant, oid, roles, id) {
      if (!FHIR_ID.test(id)) return undefined;
      const r = await get(tenant, oid, roles, `${o.fhirBaseFor(tenant)}/Patient/${encodeURIComponent(id)}`);
      // Not found, gone, or forbidden to this user all mean: this user cannot pick it.
      if (r.status === 404 || r.status === 410 || r.status === 403) return undefined;
      if (r.status < 200 || r.status > 299) throw new PatientSearchUnavailableError(`HTTP ${r.status}`);
      const s = summarize(r.body);
      return s && s.id === id ? s : undefined;
    },
  };
}
