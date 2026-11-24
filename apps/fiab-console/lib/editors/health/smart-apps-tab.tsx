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
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Caption1, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Radio, RadioGroup, Skeleton,
  SkeletonItem, Spinner, Subtitle2, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Textarea,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { AppsAddIn20Regular, Open16Regular, Rocket20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { HonestGate } from '@/lib/components/shared/honest-gate';

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
  kind: 'public' | 'asymmetric';
  allowedScopes: string[];
  redirectUris: string[];
  launchUri: string | null;
  jwksUrl: string | null;
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
                <TableHeaderCell>Type and status</TableHeaderCell>
                <TableHeaderCell>Launch URL</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {apps.map((a) => (
                  <TableRow key={a.clientId}>
                    <TableCell>
                      <div className={s.name}><span>{a.displayName}</span><span className={s.mono}>{a.clientId}</span></div>
                    </TableCell>
                    <TableCell>
                      <div className={s.badges}>
                        <Badge appearance="tint" color="informative">{a.kind}</Badge>
                        <Badge appearance="tint" color={a.status === 'active' ? 'success' : 'warning'}>{a.status}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className={s.mono}>{a.launchUri ?? 'not set'}</TableCell>
                    <TableCell>
                      <div className={s.actions}>
                        <Button size="small" appearance="primary" icon={<Rocket20Regular />} aria-label={`Launch ${a.displayName}`}
                          disabled={a.status !== 'active' || !a.launchUri || busy === a.clientId} onClick={() => setLaunching(a)}>Launch</Button>
                        <Button size="small" aria-label={`${a.status === 'active' ? 'Disable' : 'Enable'} ${a.displayName}`}
                          disabled={busy === a.clientId} onClick={() => void toggle(a)}>{a.status === 'active' ? 'Disable' : 'Enable'}</Button>
                        <Button size="small" aria-label={`Edit launch URL of ${a.displayName}`} disabled={busy === a.clientId} onClick={() => setEditing(a)}>Edit launch URL</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      {registering && (
        <RegisterDialog base={base} onClose={() => setRegistering(false)} onCreated={(a) => { setRegistering(false); setApps((cur) => [...(cur ?? []), a]); }} />
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

function RegisterDialog({ base, onClose, onCreated }: { base: string; onClose: () => void; onCreated: (a: AppRow) => void }) {
  const s = useStyles();
  const [f, setF] = useState({ displayName: '', clientId: '', redirectUris: '', launchUri: '', kind: 'public' as 'public' | 'asymmetric', jwksUrl: '' });
  const [scopes, setScopes] = useState<string[]>(['patient/*.rs', 'user/*.rs']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Problem | null>(null);
  const set = (k: keyof typeof f) => (_: unknown, d: { value: string }) => setF((v) => ({ ...v, [k]: d.value }));

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await clientFetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: f.displayName, clientId: f.clientId, launchUri: f.launchUri, kind: f.kind, allowedScopes: scopes,
          redirectUris: f.redirectUris.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          ...(f.kind === 'asymmetric' ? { jwksUrl: f.jwksUrl } : {}),
        }),
      });
      if (!r.ok) { setErr(await problemOf(r, 'The app was not registered')); return; }
      onCreated((await r.json()).app as AppRow);
    } catch (e: any) {
      setErr({ title: 'The app was not registered', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Register a SMART app</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Field label="Display name" required><Input value={f.displayName} onChange={set('displayName')} /></Field>
              <Field label="Client id" required hint="3 to 64 letters, digits, dot, underscore or hyphen. The app sends this as client_id.">
                <Input value={f.clientId} onChange={set('clientId')} />
              </Field>
              <Field label="Redirect URIs" required hint="One per line. https, or http on localhost for development.">
                <Textarea value={f.redirectUris} onChange={set('redirectUris')} resize="vertical" />
              </Field>
              <Field label="Launch URL" required hint="The app's SMART launch page. Must be https.">
                <Input value={f.launchUri} onChange={set('launchUri')} />
              </Field>
              <Field label="Client type">
                <RadioGroup value={f.kind} onChange={(_, d) => setF((v) => ({ ...v, kind: d.value as 'public' | 'asymmetric' }))}>
                  <Radio value="public" label="Public (PKCE, no client secret: browser and native apps)" />
                  <Radio value="asymmetric" label="Confidential asymmetric (private_key_jwt with a JWKS URL)" />
                </RadioGroup>
              </Field>
              {f.kind === 'asymmetric' && (
                <Field label="JWKS URL" required hint="https URL of the app's public keys."><Input value={f.jwksUrl} onChange={set('jwksUrl')} /></Field>
              )}
              <Field label="Allowed scopes" hint="The most this app can ever be granted; each user still gets only what their roles allow.">
                <div className={s.scopes}>
                  {SCOPE_CHOICES.map((c) => (
                    <Checkbox key={c.scope} label={`${c.scope} - ${c.label}`} checked={scopes.includes(c.scope)}
                      onChange={(_, d) => setScopes((cur) => (d.checked ? [...cur, c.scope] : cur.filter((x) => x !== c.scope)))} />
                  ))}
                </div>
              </Field>
              {err && <MessageBar intent="error" layout="multiline"><MessageBarBody><MessageBarTitle>{err.title}</MessageBarTitle>{err.text}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={busy || scopes.length === 0} onClick={() => void submit()}>{busy ? 'Registering...' : 'Register'}</Button>
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
                    The search runs against this tenant's FHIR service through the FHIR edge, which did not answer ({search.reason}). Until the FHIR edge is deployed for this tenant, launch the app without a patient.
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
