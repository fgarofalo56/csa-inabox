'use client';

/**
 * SmartAppsTab - the "Apps" tab of the health-tenant editor (#5454 A6, gap G8).
 *
 * SMART apps registered on the tenant's Authorization Server, read live from
 * the control plane through /api/health/tenants/[id]/apps. Register (public or
 * asymmetric), enable/disable, edit the launch URL, and Launch: the BFF mints a
 * launch handle for the signed-in user and answers the URL the browser goes to
 * (`launchUri?iss=<FHIR base>&launch=<handle>`). The launch dialog offers a
 * patient search through the AS; when that search is unavailable it says so and
 * shows no rows, and "Launch without a patient" stays available.
 *
 * Scopes are picked from a fixed list; there is no free-text scope box.
 *
 * Register also covers SMART Backend Services clients (#5151): a backend
 * service has no redirect or launch URL, picks system/ scopes and at least one
 * role from a list. A confidential client's keys come from a JWKS URL or a
 * pasted JWKS (public keys only, for a client Azure cannot reach); the paste is
 * checked by the same validator the BFF re-runs, and a private member refuses
 * it before anything is sent.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Badge, Button, Caption1, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, Label, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Radio, RadioGroup, Skeleton,
  SkeletonItem, Spinner, Subtitle2, Switch, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Textarea,
  makeStyles, tokens, useId,
} from '@fluentui/react-components';
import { AppsAddIn20Regular, Copy16Regular, Open16Regular, Rocket20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import {
  BACKEND_ROLE_CHOICES, JWKS_LIMITS, SYSTEM_SCOPE_CHOICES, jwksSummary, validatePublicJwks,
} from '@/lib/health/smart-registration';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  grow: { flex: '1 1 0', minWidth: 0 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  name: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  scopes: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  searchRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto', gap: tokens.spacingHorizontalS, alignItems: 'end' },
  skel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
});

/** Fixed scope list, mirrored from app/api/health/tenants/_lib/smart-apps.ts (the BFF refuses anything else). */
export const SCOPE_CHOICES: ReadonlyArray<{ scope: string; label: string }> = [
  { scope: 'patient/*.rs', label: 'Read the launched patient\'s data' },
  { scope: 'user/*.rs', label: 'Read what the signed-in user may read' },
  { scope: 'patient/Patient.rs', label: 'Read the launched patient\'s demographics only' },
  { scope: 'patient/Observation.rs', label: 'Read the launched patient\'s observations only' },
  { scope: 'patient/*.cruds', label: 'Read and write the launched patient\'s data' },
  { scope: 'user/*.cruds', label: 'Read and write what the signed-in user may' },
];

export interface AppRow {
  clientId: string;
  displayName: string;
  status: 'active' | 'disabled';
  /** Absent from a BFF that predates backend clients; read as 'app'. */
  clientType?: 'app' | 'backend';
  kind: 'public' | 'asymmetric';
  /** url / inline (count + kids only; the BFF never sends key material) / none (public). */
  keySource?: 'url' | 'inline' | 'none';
  keyCount?: number;
  kids?: string[];
  allowedScopes: string[];
  roleIds?: string[];
  /** Backend only: may call the tenant introspection endpoint. */
  introspect?: boolean;
  redirectUris: string[];
  launchUri: string | null;
  jwksUrl: string | null;
}

/** The apps-table "Keys" cell: where the verifying keys come from. Inline keys are a count and kids, never a modulus. */
export function keySourceText(a: AppRow): string {
  if (a.keySource === 'inline') {
    const n = a.keyCount ?? 0;
    return `Inline: ${n} public ${n === 1 ? 'key' : 'keys'}${a.kids?.length ? ` (${a.kids.join(', ')})` : ''}`;
  }
  if (a.keySource === 'url' || a.jwksUrl) return `JWKS URL: ${a.jwksUrl ?? ''}`.trim();
  return 'None (public client)';
}
interface PatientRow { id: string; name: string; birthDate?: string; gender?: string }
type Problem = { title: string; text: string };

/** Read an error envelope as a title + text the tab can show. A 403 names the grant that is missing. */
async function problemOf(r: Response, title: string): Promise<Problem> {
  let j: any = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  if (r.status === 403) return { title: 'Health Tenant Admin required', text: `${j?.error || 'forbidden'}. ${j?.remediation || ''}`.trim() };
  return { title, text: j?.error || `HTTP ${r.status}` };
}

export function SmartAppsTab({ id, navigate = (url: string) => window.location.assign(url) }: { id: string; navigate?: (url: string) => void }) {
  const s = useStyles();
  const base = `/api/health/tenants/${encodeURIComponent(id)}/apps`;
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [gate, setGate] = useState<any>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [editing, setEditing] = useState<AppRow | null>(null);
  const [launching, setLaunching] = useState<AppRow | null>(null);
  const [registered, setRegistered] = useState<AppRow | null>(null);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const r = await clientFetch(base);
      if (r.status === 503) {
        const j = await r.json();
        if (j?.gated) { setGate(j.gate); setApps([]); return; }
      }
      if (!r.ok) { setProblem(await problemOf(r, 'Could not list the apps')); setApps([]); return; }
      const j = await r.json();
      setGate(null);
      setApps(Array.isArray(j?.apps) ? j.apps : []);
    } catch (e: any) {
      setProblem({ title: 'Could not list the apps', text: e?.message || String(e) });
      setApps([]);
    }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  const patch = useCallback(async (app: AppRow, body: { status?: 'active' | 'disabled'; launchUri?: string | null }): Promise<Problem | null> => {
    setBusy(app.clientId);
    try {
      const r = await clientFetch(`${base}/${encodeURIComponent(app.clientId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) return problemOf(r, `Could not update ${app.displayName}`);
      const j = await r.json();
      setApps((cur) => (cur ?? []).map((a) => (a.clientId === app.clientId ? (j.app as AppRow) : a)));
      return null;
    } catch (e: any) {
      return { title: `Could not update ${app.displayName}`, text: e?.message || String(e) };
    } finally { setBusy(null); }
  }, [base]);

  const toggle = useCallback(async (app: AppRow) => {
    const p = await patch(app, { status: app.status === 'active' ? 'disabled' : 'active' });
    if (p) setProblem(p);
  }, [patch]);

  if (apps === null) {
    return (
      <Skeleton aria-label="Loading apps" className={s.skel}>
        <SkeletonItem size={24} /><SkeletonItem size={16} /><SkeletonItem size={16} />
      </Skeleton>
    );
  }

  return (
    <div className={s.root}>
      {gate && <HonestGate gate={gate} surface="Health tenant apps" onResolved={() => void load()} />}
      {registered && (
        <MessageBar intent="success" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Registered {registered.displayName}</MessageBarTitle>
            <div className={s.head}>Configure the app with this client id: <CopyId value={registered.clientId} /></div>
          </MessageBarBody>
          <MessageBarActions><Button size="small" onClick={() => setRegistered(null)}>Dismiss</Button></MessageBarActions>
        </MessageBar>
      )}
      {problem && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody><MessageBarTitle>{problem.title}</MessageBarTitle>{problem.text}</MessageBarBody>
          <MessageBarActions><Button size="small" onClick={() => void load()}>Try again</Button></MessageBarActions>
        </MessageBar>
      )}
      {!gate && apps.length === 0 && !problem && (
        <EmptyState
          icon={<AppsAddIn20Regular />}
          title="No SMART apps yet"
          body="Register a SMART on FHIR app to launch it from here with this tenant's FHIR base and a launch context for you."
          primaryAction={{ label: 'Register app', onClick: () => setRegistering(true) }}
        />
      )}
      {apps.length > 0 && (
        <div className={s.card}>
          <div className={s.head}>
            <AppsAddIn20Regular />
            <Subtitle2 className={s.grow}>SMART apps</Subtitle2>
            <Button appearance="primary" size="small" onClick={() => setRegistering(true)}>Register app</Button>
          </div>
          <Caption1>Apps registered on this tenant's authorization server. Launch opens the app with this tenant's FHIR base and a single-use launch context for you.</Caption1>
          <div className={s.tableWrap}>
            <Table aria-label="SMART apps" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>App</TableHeaderCell>
                <TableHeaderCell>Kind, type and status</TableHeaderCell>
                <TableHeaderCell>Keys</TableHeaderCell>
                <TableHeaderCell>Launch URL</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {apps.map((a) => {
                  const isBackend = a.clientType === 'backend';
                  return (
                    <TableRow key={a.clientId}>
                      <TableCell>
                        <div className={s.name}><span>{a.displayName}</span><CopyId value={a.clientId} /></div>
                      </TableCell>
                      <TableCell>
                        <div className={s.badges}>
                          <Badge appearance="tint" color="brand">{isBackend ? 'backend service' : 'app'}</Badge>
                          {isBackend && a.introspect && <Badge appearance="tint" color="important">introspection</Badge>}
                          <Badge appearance="tint" color="informative">{a.kind}</Badge>
                          <Badge appearance="tint" color={a.status === 'active' ? 'success' : 'warning'}>{a.status}</Badge>
                        </div>
                      </TableCell>
                      <TableCell className={s.mono}>{keySourceText(a)}</TableCell>
                      <TableCell className={s.mono}>{isBackend ? 'not applicable (no user launch)' : (a.launchUri ?? 'not set')}</TableCell>
                      <TableCell>
                        <div className={s.actions}>
                          {!isBackend && (
                            <Button size="small" appearance="primary" icon={<Rocket20Regular />} aria-label={`Launch ${a.displayName}`}
                              disabled={a.status !== 'active' || !a.launchUri || busy === a.clientId} onClick={() => setLaunching(a)}>Launch</Button>
                          )}
                          <Button size="small" aria-label={`${a.status === 'active' ? 'Disable' : 'Enable'} ${a.displayName}`}
                            disabled={busy === a.clientId} onClick={() => void toggle(a)}>{a.status === 'active' ? 'Disable' : 'Enable'}</Button>
                          {!isBackend && (
                            <Button size="small" aria-label={`Edit launch URL of ${a.displayName}`} disabled={busy === a.clientId} onClick={() => setEditing(a)}>Edit launch URL</Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      {registering && (
        <RegisterDialog base={base} onClose={() => setRegistering(false)} onCreated={(a) => { setRegistering(false); setRegistered(a); setApps((cur) => [...(cur ?? []), a]); }} />
      )}
      {editing && (
        <EditLaunchDialog app={editing} onClose={() => setEditing(null)} save={async (launchUri) => {
          const p = await patch(editing, { launchUri });
          if (!p) setEditing(null);
          return p;
        }} />
      )}
      {launching && <LaunchDialog base={base} app={launching} navigate={navigate} onClose={() => setLaunching(null)} />}
    </div>
  );
}

/** A read-only client id with a copy button. The id is assigned by the BFF, never typed. */
function CopyId({ value }: { value: string }) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);
  return (
    <span className={s.head}>
      <span className={s.mono}>{value}</span>
      <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label={`Copy client id ${value}`}
        onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false)); }}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

/**
 * A labelled checkbox list. Not a `Field`: a Field hands its label to EVERY Checkbox inside it, which left each
 * scope checkbox with an empty accessible name. Here the group carries the label and each box keeps its own.
 */
function CheckGroup({ label, hint, required, children }: { label: string; hint: string; required?: boolean; children: ReactNode }) {
  const s = useStyles();
  const id = useId('checkgroup');
  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} className={s.scopes}>
      <Label id={`${id}-label`} required={required}>{label}</Label>
      {children}
      <Caption1 id={`${id}-hint`}>{hint}</Caption1>
    </div>
  );
}

type ClientKind = 'app' | 'backend';
type KeySource = 'url' | 'inline';

function RegisterDialog({ base, onClose, onCreated }: { base: string; onClose: () => void; onCreated: (a: AppRow) => void }) {
  const s = useStyles();
  const [f, setF] = useState({ displayName: '', redirectUris: '', launchUri: '', kind: 'public' as 'public' | 'asymmetric', jwksUrl: '', jwksText: '' });
  const [clientType, setClientType] = useState<ClientKind>('app');
  const [keySource, setKeySource] = useState<KeySource>('url');
  const [scopes, setScopes] = useState<string[]>(['patient/*.rs', 'user/*.rs']);
  const [roles, setRoles] = useState<string[]>([]);
  const [introspect, setIntrospect] = useState(false);
  const [jwksTouched, setJwksTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Problem | null>(null);
  const set = (k: keyof typeof f) => (_: unknown, d: { value: string }) => setF((v) => ({ ...v, [k]: d.value }));

  const backend = clientType === 'backend';
  const asymmetric = backend || f.kind === 'asymmetric';
  const inline = asymmetric && keySource === 'inline';
  // The same validator the BFF runs. Shown only after the textarea is touched (a fresh dialog opens clean).
  const jwks = inline && f.jwksText.trim() ? validatePublicJwks(f.jwksText) : null;
  const jwksError = jwks && 'error' in jwks ? jwks.error : null;
  const jwksOk = jwks && 'jwks' in jwks ? jwksSummary(jwks.jwks) : null;
  const scopeChoices = backend ? SYSTEM_SCOPE_CHOICES : SCOPE_CHOICES;
  const blocked = busy || scopes.length === 0 || (backend && roles.length === 0) || (inline && !jwksOk);

  const pickClientType = (next: ClientKind) => {
    setClientType(next);
    // Scopes are per kind (system/ for backend, patient/ user/ for an app), so the picks reset with the kind.
    setScopes(next === 'backend' ? ['system/*.rs'] : ['patient/*.rs', 'user/*.rs']);
    if (next === 'backend') setF((v) => ({ ...v, kind: 'asymmetric' }));
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await clientFetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: f.displayName, clientType, kind: asymmetric ? 'asymmetric' : 'public', allowedScopes: scopes,
          ...(backend ? { roleIds: roles, ...(introspect ? { introspect: true } : {}) } : {
            launchUri: f.launchUri, redirectUris: f.redirectUris.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          }),
          ...(asymmetric && !inline ? { jwksUrl: f.jwksUrl } : {}),
          ...(inline && jwks && 'jwks' in jwks ? { jwks: jwks.jwks } : {}),
        }),
      });
      if (!r.ok) { setErr(await problemOf(r, 'The client was not registered')); return; }
      onCreated((await r.json()).app as AppRow);
    } catch (e: any) {
      setErr({ title: 'The client was not registered', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Register a SMART client</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Field label="Display name" required hint="Shown to users and in the audit trail.">
                <Input value={f.displayName} onChange={set('displayName')} />
              </Field>
              <Field label="Client kind" hint="An app is launched by a signed-in user. A backend service runs without a user (SMART Backend Services).">
                <RadioGroup value={clientType} onChange={(_, d) => pickClientType(d.value as ClientKind)}>
                  <Radio value="app" label="App (user launch)" />
                  <Radio value="backend" label="Backend service (system, no user)" />
                </RadioGroup>
              </Field>
              {!backend && (
                <>
                  <Field label="Redirect URIs" required hint="One per line. https, or http on localhost for development.">
                    <Textarea value={f.redirectUris} onChange={set('redirectUris')} resize="vertical" />
                  </Field>
                  <Field label="Launch URL" required hint="The app's SMART launch page. Must be https.">
                    <Input value={f.launchUri} onChange={set('launchUri')} />
                  </Field>
                  <Field label="Client type">
                    <RadioGroup value={f.kind} onChange={(_, d) => setF((v) => ({ ...v, kind: d.value as 'public' | 'asymmetric' }))}>
                      <Radio value="public" label="Public (PKCE, no client secret: browser and native apps)" />
                      <Radio value="asymmetric" label="Confidential asymmetric (private_key_jwt)" />
                    </RadioGroup>
                  </Field>
                </>
              )}
              {asymmetric && (
                <Field label="Key source" hint={backend ? 'A backend service signs its token request with private_key_jwt (RS384 or ES384).' : 'Where the authorization server reads the public keys that verify the client assertion.'}>
                  <RadioGroup value={keySource} onChange={(_, d) => setKeySource(d.value as KeySource)}>
                    <Radio value="url" label="JWKS URL" />
                    <Radio value="inline" label="Paste JWKS (public keys)" />
                  </RadioGroup>
                </Field>
              )}
              {asymmetric && !inline && (
                <Field label="JWKS URL" required hint="https URL of the client's public keys, reachable from Azure."><Input value={f.jwksUrl} onChange={set('jwksUrl')} /></Field>
              )}
              {inline && (
                <Field label="Public JWKS" required
                  validationState={jwksTouched && jwksError ? 'error' : jwksOk ? 'success' : 'none'}
                  validationMessage={jwksTouched && jwksError ? jwksError
                    : jwksOk ? `${jwksOk.keyCount} public ${jwksOk.keyCount === 1 ? 'key' : 'keys'}: ${jwksOk.kids.join(', ')}` : undefined}
                  hint={`For a client Azure cannot reach. {"keys":[...]} with RSA (2048+ bits) or EC P-384 keys, each with a kid; alg RS384 or ES384. Public members only: a key with d, p, q, dp, dq, qi, k or oth is refused. At most ${JWKS_LIMITS.maxKeys} keys, ${JWKS_LIMITS.maxBytes / 1024} KB.`}>
                  <Textarea className={s.mono} value={f.jwksText} resize="vertical" rows={6}
                    onChange={(_, d) => { setF((v) => ({ ...v, jwksText: d.value })); setJwksTouched(true); }} />
                </Field>
              )}
              {backend && (
                <CheckGroup label="Roles" required hint="The roles whose system ceilings bound every token this service gets.">
                  {BACKEND_ROLE_CHOICES.map((r) => (
                    <Checkbox key={r.id} label={`${r.label} (${r.id})`} checked={roles.includes(r.id)}
                      onChange={(_, d) => setRoles((cur) => (d.checked ? [...cur, r.id] : cur.filter((x) => x !== r.id)))} />
                  ))}
                </CheckGroup>
              )}
              {backend && (
                <Field label="Token introspection" hint="Lets this service check other tokens issued on this tenant (RFC 7662 introspection endpoint). Off unless the service validates tokens it receives.">
                  <Switch label="Allow token introspection" checked={introspect} onChange={(_, d) => setIntrospect(d.checked)} />
                </Field>
              )}
              <CheckGroup label="Allowed scopes" hint={backend ? 'The most this service can ever be granted; its roles cap it further.' : 'The most this app can ever be granted; each user still gets only what their roles allow.'}>
                {scopeChoices.map((c) => (
                  <Checkbox key={c.scope} label={`${c.scope} - ${c.label}`} checked={scopes.includes(c.scope)}
                    onChange={(_, d) => setScopes((cur) => (d.checked ? [...cur, c.scope] : cur.filter((x) => x !== c.scope)))} />
                ))}
              </CheckGroup>
              {err && <MessageBar intent="error" layout="multiline"><MessageBarBody><MessageBarTitle>{err.title}</MessageBarTitle>{err.text}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={blocked} onClick={() => void submit()}>{busy ? 'Registering...' : 'Register'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function EditLaunchDialog({ app, onClose, save }: { app: AppRow; onClose: () => void; save: (launchUri: string) => Promise<Problem | null> }) {
  const s = useStyles();
  const [value, setValue] = useState(app.launchUri ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Problem | null>(null);
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Launch URL of {app.displayName}</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Field label="Launch URL" hint="Must be https. Launch sends the browser here with iss and launch added.">
                <Input value={value} onChange={(_, d) => setValue(d.value)} />
              </Field>
              {err && <MessageBar intent="error" layout="multiline"><MessageBarBody><MessageBarTitle>{err.title}</MessageBarTitle>{err.text}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={busy || !value.trim()} onClick={async () => {
              setBusy(true);
              setErr(await save(value.trim()));
              setBusy(false);
            }}>Save</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * The unavailable MessageBar text for the CP's `reason`, stated no more strongly than the CP established it
 * (deploy-integrity R7). Only `timeout` / `no response` mean the endpoint did not answer; an `HTTP <n>` means it DID
 * answer; a role-check failure is not about the edge at all. Anything else is shown verbatim.
 */
export function unavailableText(reason: string): string {
  if (reason === 'timeout' || reason === 'no response') {
    return `The tenant's FHIR endpoint did not answer (${reason}). The FHIR edge may not be deployed for this tenant yet. Launch the app without a patient meanwhile.`;
  }
  if (reason === 'role membership could not be established') {
    return 'Your role membership in this tenant could not be checked, so the search did not run. Try again, or launch the app without a patient.';
  }
  const http = /^HTTP (\d{3})$/.exec(reason);
  if (http) return `The tenant's FHIR endpoint answered HTTP ${http[1]}, so no patients can be listed. Launch the app without a patient, or try again later.`;
  return `The search did not complete: ${reason}. Launch the app without a patient meanwhile.`;
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'results'; patients: PatientRow[] }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not-permitted' }
  | { kind: 'error'; text: string };

function LaunchDialog({ base, app, navigate, onClose }: { base: string; app: AppRow; navigate: (url: string) => void; onClose: () => void }) {
  const s = useStyles();
  const [q, setQ] = useState('');
  const [birthdate, setBirthdate] = useState('');
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const [launching, setLaunching] = useState(false);
  const [err, setErr] = useState<Problem | null>(null);

  const runSearch = async () => {
    setSearch({ kind: 'searching' });
    try {
      const r = await clientFetch(`${base}/patient-search`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: q.trim(), ...(birthdate.trim() ? { birthdate: birthdate.trim() } : {}) }),
      });
      if (!r.ok) { setSearch({ kind: 'error', text: (await problemOf(r, 'Search failed')).text }); return; }
      const j = await r.json();
      if (j?.unavailable) setSearch({ kind: 'unavailable', reason: String(j.reason ?? 'no reason given') });
      else if (j?.notPermitted) setSearch({ kind: 'not-permitted' });
      else setSearch({ kind: 'results', patients: Array.isArray(j?.patients) ? j.patients : [] });
    } catch (e: any) {
      setSearch({ kind: 'error', text: e?.message || String(e) });
    }
  };

  const launch = async (patient?: string) => {
    setLaunching(true);
    setErr(null);
    try {
      const r = await clientFetch(`${base}/${encodeURIComponent(app.clientId)}/launch`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patient ? { patient } : {}),
      });
      if (!r.ok) { setErr(await problemOf(r, 'The app could not be launched')); return; }
      const j = await r.json();
      navigate(String(j.url));
    } catch (e: any) {
      setErr({ title: 'The app could not be launched', text: e?.message || String(e) });
    } finally { setLaunching(false); }
  };

  const searchDown = search.kind === 'unavailable' || search.kind === 'not-permitted';
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Launch {app.displayName}</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Caption1>Choose the patient the app opens with, or launch it with no patient in context. The launch is single-use and bound to you.</Caption1>
              <div className={s.searchRow}>
                <Field label="Patient name"><Input value={q} onChange={(_, d) => setQ(d.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) void runSearch(); }} /></Field>
                <Field label="Birth date" hint="Optional, YYYY-MM-DD"><Input value={birthdate} onChange={(_, d) => setBirthdate(d.value)} /></Field>
                <Button disabled={!q.trim() || search.kind === 'searching'} onClick={() => void runSearch()}>Search</Button>
              </div>
              {search.kind === 'searching' && <Spinner size="tiny" label="Searching patients" />}
              {search.kind === 'unavailable' && (
                <MessageBar intent="warning" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>Patient search is unavailable</MessageBarTitle>
                    {unavailableText(search.reason)}
                  </MessageBarBody>
                </MessageBar>
              )}
              {search.kind === 'not-permitted' && (
                <MessageBar intent="info" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>You cannot search patients in this tenant</MessageBarTitle>
                    None of your roles here allows reading Patient records. Launch the app without a patient, or ask a tenant administrator for a role that does.
                  </MessageBarBody>
                </MessageBar>
              )}
              {search.kind === 'error' && (
                <MessageBar intent="error" layout="multiline"><MessageBarBody><MessageBarTitle>Search failed</MessageBarTitle>{search.text}</MessageBarBody></MessageBar>
              )}
              {search.kind === 'results' && (search.patients.length === 0 ? (
                <Caption1>No patient you may see matches that search.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Matching patients" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Birth date</TableHeaderCell><TableHeaderCell>Id</TableHeaderCell><TableHeaderCell />
                    </TableRow></TableHeader>
                    <TableBody>
                      {search.patients.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell>{p.name || '(no name recorded)'}</TableCell>
                          <TableCell>{p.birthDate ?? '-'}</TableCell>
                          <TableCell className={s.mono}>{p.id}</TableCell>
                          <TableCell>
                            <Button size="small" appearance="primary" icon={<Open16Regular />} disabled={launching} aria-label={`Launch with ${p.name || p.id}`} onClick={() => void launch(p.id)}>Launch</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))}
              {err && <MessageBar intent="error" layout="multiline"><MessageBarBody><MessageBarTitle>{err.title}</MessageBarTitle>{err.text}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            {/* Always offered; the primary action when the search cannot run for this user. */}
            <Button appearance={searchDown ? 'primary' : 'secondary'} disabled={launching} onClick={() => void launch()}>Launch without a patient</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
