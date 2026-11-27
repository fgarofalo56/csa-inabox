// Server-rendered HTML for the standalone patient picker (#5454 A5). No
// JavaScript, no external assets: the CSP sent with every page forbids both.
// The picker is the only HTML this AS serves: there is no user consent page
// (the grant is role-bounded) and the EHR launch redirects with no interstitial.
// Every interpolated value goes through escapeHtml, including values the
// platform itself produced, so no caller has to remember which are safe.

import type { PatientSummary } from './patient-search.js';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes the five HTML-significant characters. Safe in element content and in double- or single-quoted attributes. */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

/**
 * The picker page's CSP, with `form-action` naming where its forms may navigate.
 *
 * `form-action` also governs the REDIRECT that follows a form submission in Chromium-based browsers (MDN,
 * "Content-Security-Policy: form-action": "Chrome 63 does [block the redirects]", w3c/webappsec-csp#8). The
 * picker's Continue / Cancel / Continue-without-a-patient POSTs answer 302 to the client's redirect_uri, so with
 * `form-action 'self'` alone Chromium silently blocks that redirect and the user stays on /pick (measured live
 * 2026-11-27 on Commercial dev01: `auth.pick_issued` logged, 302 sent, the browser never left the page). The page
 * for ONE pick therefore also allows the ORIGIN (never the path or query, never a wildcard) of that pick's stored,
 * registration-validated redirect_uri. A page with no pick context passes nothing and keeps `'self'` only.
 */
export function pickerCsp(formTargetOrigin?: string): string {
  const formAction = formTargetOrigin ? `'self' ${formTargetOrigin}` : "'self'";
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;
}

/**
 * A CSP host-source for the origin: scheme, dot-separated LDH labels (ASCII after IDNA, which `URL` already applied),
 * optional port. This is deliberately NARROWER than what `new URL()` accepts: the WHATWG URL parser keeps `;`, `,`,
 * `'`, `"`, `*` and `$` in a host (`new URL('https://a;b.com/').origin === 'https://a;b.com'`), and a `;` would end the
 * form-action directive and start an attacker-chosen one. IPv6 literals are refused too: CSP host-source has no
 * bracketed-host production.
 */
const CSP_HOST_SOURCE = /^https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?$/;

/** Why a redirect_uri yields no form-action source. */
export type FormActionRefusal = 'unparseable' | 'not-serializable';

/**
 * The `form-action` source for a stored redirect_uri: its serialized origin, or a refusal (the caller logs it and the
 * page keeps `'self'` only). Never call this with a value from the request: only with the pick grant's stored
 * redirectUri, which was matched exactly against the client's registered list at /authorize.
 */
export function formActionSource(redirectUri: string): { source: string } | { refused: FormActionRefusal } {
  let origin: string;
  try {
    origin = new URL(redirectUri).origin;
  } catch {
    return { refused: 'unparseable' };
  }
  return CSP_HOST_SOURCE.test(origin) ? { source: origin } : { refused: 'not-serializable' };
}

/** Response headers for a picker page: nothing may run, frame it, or leak its URL (which carries the pick id). */
export function pickerHeaders(formTargetOrigin?: string): Readonly<Record<string, string>> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': pickerCsp(formTargetOrigin),
    'x-frame-options': 'DENY',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

/** Headers for a picker page with no pick context (the dead-end refusal and error pages): `form-action 'self'` only. */
export const PICKER_HEADERS: Readonly<Record<string, string>> = pickerHeaders();

// Fluent-like neutral palette with the Loom brand blue, light and dark. One const, inline (CSP allows inline style only).
const CSS = `
:root{color-scheme:light dark;--bg:#f5f5f5;--card:#ffffff;--fg:#242424;--muted:#616161;--border:#e0e0e0;--row:#fafafa;
--row-hover:#f0f6fc;--brand:#0f6cbd;--brand-hover:#115ea3;--brand-fg:#ffffff;--focus:#0f6cbd;--warn-bg:#fff9f5;--warn-border:#f4bfab;
--err-bg:#fdf3f4;--err-border:#eeacb2;--shadow:0 2px 4px rgba(0,0,0,.14),0 8px 16px rgba(0,0,0,.10)}
@media (prefers-color-scheme:dark){:root{--bg:#1f1f1f;--card:#292929;--fg:#ffffff;--muted:#adadad;--border:#424242;--row:#2e2e2e;
--row-hover:#082338;--brand:#479ef5;--brand-hover:#62abf5;--brand-fg:#0a0a0a;--focus:#62abf5;--warn-bg:#3a2a1e;--warn-border:#8a4b2f;
--err-bg:#3b1f22;--err-border:#9f3c45;--shadow:0 2px 4px rgba(0,0,0,.4),0 8px 16px rgba(0,0,0,.3)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;background:var(--bg);color:var(--fg);
font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",Arial,sans-serif;
font-size:14px;line-height:20px;padding:48px 16px}
.card{width:100%;max-width:560px;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);
padding:28px 28px 24px;min-width:0}
.brand{display:flex;align-items:center;gap:8px;color:var(--brand);font-weight:600;font-size:12px;letter-spacing:.04em;text-transform:uppercase}
.brand::before{content:"";width:10px;height:10px;border-radius:3px;background:var(--brand)}
h1{font-size:20px;line-height:28px;font-weight:600;margin:8px 0 4px}
.hint{color:var(--muted);margin:0 0 20px;overflow-wrap:anywhere}
form{margin:0}
.search{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,160px) auto;gap:12px;align-items:end;margin-bottom:20px}
@media (max-width:520px){.search{grid-template-columns:minmax(0,1fr)}}
label{display:block;font-weight:600;margin-bottom:4px}
.opt{font-weight:400;color:var(--muted)}
input[type=search],input[type=date]{width:100%;min-width:0;height:32px;padding:0 10px;border:1px solid var(--border);
border-bottom-color:var(--muted);border-radius:4px;background:var(--card);color:var(--fg);font:inherit}
button{height:32px;padding:0 16px;border-radius:4px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--border);
background:var(--card);color:var(--fg)}
button:hover{background:var(--row-hover)}
button.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-fg)}
button.primary:hover{background:var(--brand-hover)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{font-weight:600;margin-bottom:8px;padding:0}
.results{list-style:none;margin:0 0 20px;padding:0;display:flex;flex-direction:column;gap:6px}
.results label{display:flex;align-items:center;gap:12px;margin:0;font-weight:400;padding:10px 12px;border:1px solid var(--border);
border-radius:8px;background:var(--row);cursor:pointer;min-width:0}
.results label:hover{background:var(--row-hover)}
.results input{margin:0;accent-color:var(--brand);flex:none}
.results input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.who{display:flex;flex-direction:column;min-width:0}
.name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.note{border:1px solid var(--warn-border);background:var(--warn-bg);border-radius:8px;padding:12px 14px;margin:0 0 20px}
.note.error{border-color:var(--err-border);background:var(--err-bg)}
.note strong{display:block;margin-bottom:2px}
.actions{display:flex;flex-wrap:wrap;gap:8px}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><main class="card" aria-labelledby="title"><div class="brand">CSA Loom Health</div>${body}</main></body></html>`;
}

const note = (kind: 'warning' | 'error', heading: string, text: string): string =>
  `<div class="note${kind === 'error' ? ' error' : ''}" role="${kind === 'error' ? 'alert' : 'status'}"><strong>${escapeHtml(heading)}</strong>${escapeHtml(text)}</div>`;

/** What the page body shows under the search form. */
export type PickerState =
  | { kind: 'start' }
  | { kind: 'results'; patients: PatientSummary[] }
  | { kind: 'empty' }
  | { kind: 'invalid-input'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'not-permitted' }
  | { kind: 'error'; heading: string; message: string };

export interface PickerView {
  /** Path the forms submit to: `{base}/{tenant}/pick`. */
  action: string;
  req: string;
  csrf: string;
  appName: string;
  tenant: string;
  query: { name: string; birthdate: string };
  state: PickerState;
}

function patientRow(p: PatientSummary, i: number): string {
  const meta = [p.birthDate ? `Born ${p.birthDate}` : '', p.gender ?? '', `ID ${p.id}`].filter(Boolean).join(' · ');
  return `<li><label for="p${i}"><input type="radio" id="p${i}" name="patient" value="${escapeHtml(p.id)}" required>
<span class="who"><span class="name">${escapeHtml(p.name || '(no name recorded)')}</span><span class="meta">${escapeHtml(meta)}</span></span></label></li>`;
}

/** The picker: search form (POST action=search: search terms are PHI and stay out of URLs) and, in a second POST form, the results or the state message plus Continue/Cancel. */
export function renderPicker(v: PickerView): string {
  const s = v.state;
  const canSearch = s.kind !== 'not-permitted';
  const search = canSearch
    ? `<form method="post" action="${escapeHtml(v.action)}" class="search" role="search" aria-label="Search patients">
<input type="hidden" name="req" value="${escapeHtml(v.req)}"><input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">
<div><label for="q">Patient name</label><input id="q" name="q" type="search" value="${escapeHtml(v.query.name)}" maxlength="100" required autocomplete="off"></div>
<div><label for="birthdate">Birth date <span class="opt">(optional)</span></label><input id="birthdate" name="birthdate" type="date" value="${escapeHtml(v.query.birthdate)}"></div>
<button type="submit" name="action" value="search">Search</button></form>`
    : '';
  let middle = '';
  let canContinue = false;
  switch (s.kind) {
    case 'start':
      break;
    case 'results':
      canContinue = true;
      middle = `<fieldset><legend>${s.patients.length} matching patient${s.patients.length === 1 ? '' : 's'}</legend><ul class="results">${s.patients.map(patientRow).join('')}</ul></fieldset>`;
      break;
    case 'empty':
      middle = note('warning', 'No matching patients', 'No patient you are permitted to see matches this search. Try another name or remove the birth date.');
      break;
    case 'invalid-input':
      middle = note('warning', 'Check the search', s.message);
      break;
    case 'unavailable':
      middle = note('error', 'Patient search is unavailable', 'The tenant FHIR endpoint could not be searched, so no patient can be selected right now. Cancel to return to the app, or try again later.');
      break;
    case 'not-permitted':
      middle = note('error', 'You are not permitted to search patients in this tenant', 'Your roles in this tenant do not include reading Patient records. Ask a tenant administrator for a FHIR reader role. You can continue without a patient (the app gets no patient-level access) or cancel to return to the app.');
      break;
    case 'error':
      middle = note('error', s.heading, s.message);
      break;
  }
  const actions = `<form method="post" action="${escapeHtml(v.action)}">
<input type="hidden" name="req" value="${escapeHtml(v.req)}"><input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">
${middle}<div class="actions">${canContinue ? '<button type="submit" name="action" value="select" class="primary">Continue with this patient</button>' : ''}
<button type="submit" name="action" value="cancel" formnovalidate>Cancel</button>${s.kind === 'not-permitted' ? ' <button type="submit" name="action" value="continue" formnovalidate>Continue without a patient</button>' : ''}</div></form>`;
  const intro = `<h1 id="title">Select a patient</h1><p class="hint">${escapeHtml(v.appName)} is asking for one patient's record in ${escapeHtml(v.tenant)}. Search by name, then choose the patient.</p>`;
  return page('Select a patient - CSA Loom Health', intro + search + actions);
}

/** A dead end with nothing to submit: the pick request itself is not usable, so there is nowhere safe to send the user. */
export function renderPickerError(heading: string, message: string): string {
  return page(`${heading} - CSA Loom Health`, `<h1 id="title">${escapeHtml(heading)}</h1><p class="hint">${escapeHtml(message)}</p>`);
}
