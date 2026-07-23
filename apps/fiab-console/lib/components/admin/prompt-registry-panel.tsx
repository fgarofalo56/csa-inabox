'use client';

/**
 * PromptRegistryPanel — the "Prompts" tab of /admin/copilot-quality (N13).
 *
 * Renders the REAL LLMOps prompt registry from
 * GET /api/admin/copilot-quality/prompts (Cosmos `loom-prompt-registry`):
 * every registered prompt, its semver'd versions, the eval score each version
 * carries (a REAL copilot-evaluator `eval-run` rollup — WS-E's harness, reused,
 * never re-implemented), and the audited approve / rollback controls.
 *
 * Publishing a version requests a run from the EXISTING E2 evaluator Function —
 * the same HTTP trigger the E5 "Run now" button and the E4 workflow use — so a
 * prompt bump is graded by the EXISTING check-eval-regression floor gate. There
 * is NO second eval harness and NO second CI gate on this surface.
 *
 * States mirror the sibling tabs: Skeleton, guided EmptyState, HonestGate +
 * Fix-it when the evaluator Function is unwired, FLAG0 kill-switch notice
 * (n13-prompt-registry), clean first-open (nothing red before an action).
 * Fluent v9 + Loom tokens only; badge rows wrap (flexWrap + minWidth:0) so
 * nothing overlaps at narrow widths. Azure-native, no Fabric/Power BI.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Dialog, DialogSurface, DialogTitle, DialogBody,
  DialogContent, DialogActions, Dropdown, Field, Input, Link as FluentLink, MessageBar,
  MessageBarBody, MessageBarTitle, Option, Skeleton, SkeletonItem, Spinner, Subtitle2,
  Switch, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text,
  Textarea, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, ArrowUndo20Regular, CheckmarkCircle20Regular,
  DocumentBulletList24Regular, Send20Regular, TargetArrow24Regular, Warning20Regular,
} from '@fluentui/react-icons';
import NextLink from 'next/link';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { HonestGate } from '@/lib/components/shared/honest-gate';

interface PromptEvalScore {
  surface: string;
  runId: string;
  finishedAt: string;
  questions: number;
  retrievalHitRate: number;
  groundingAvg: number | null;
  passRate: number;
  belowFloor: boolean;
  belowFloorMetrics: string[];
  provisionalFloor: boolean;
}

interface PromptSummary {
  promptId: string;
  surface: string;
  label: string;
  description: string;
  owner: string;
  activeVersion: string | null;
  activeScore: PromptEvalScore | null;
  activeApproval: { approvedBy: string; approvedAt: string; note?: string; overrodeFloor?: boolean } | null;
  latestVersion: string | null;
  latestStatus: string | null;
  versionCount: number;
  pendingApproval: boolean;
  updatedAt: string;
}

interface PromptVersion {
  version: string;
  template: string;
  notes?: string;
  status: 'draft' | 'published' | 'approved' | 'rolled-back';
  evalRunId?: string | null;
  evalScore?: PromptEvalScore;
  evalGate?: { gateId: string; missing: string[]; remediation: string } | null;
  approval?: { approvedBy: string; approvedAt: string; note?: string; overrodeFloor?: boolean };
  createdAt: string;
  createdBy: string;
}

interface PromptsResponse {
  ok: boolean;
  flagEnabled: boolean;
  prompts: PromptSummary[];
  evaluatorConfigured: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: tokens.spacingHorizontalL },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, transition: 'box-shadow 0.15s ease', ':hover': { boxShadow: tokens.shadow16 },
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  wide: { maxWidth: '920px', width: '92vw' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
});

const pct = (v: number): string => `${Math.round(v * 100)}%`;

const STATUS_COLOR: Record<PromptVersion['status'], 'success' | 'brand' | 'warning' | 'informative'> = {
  approved: 'success', published: 'brand', draft: 'informative', 'rolled-back': 'warning',
};

/** The score chips for one version — deterministic metrics first, judge second. */
function ScoreBadges({ score }: { score?: PromptEvalScore | null }) {
  const styles = useStyles();
  if (!score) return <Caption1 className={styles.muted}>no eval score yet</Caption1>;
  return (
    <div className={styles.badges}>
      <Badge appearance="outline" size="small">hit-rate {pct(score.retrievalHitRate)}</Badge>
      <Badge appearance="outline" size="small">
        grounding {score.groundingAvg == null ? 'deferred' : `${score.groundingAvg.toFixed(2)}/5`}
      </Badge>
      <Badge appearance="outline" size="small">pass {pct(score.passRate)}</Badge>
      {score.belowFloor ? (
        <Badge appearance="tint" color="danger" size="small" icon={<Warning20Regular />}>
          below floor: {score.belowFloorMetrics.join(', ')}
        </Badge>
      ) : (
        <Badge appearance="tint" color="success" size="small" icon={<CheckmarkCircle20Regular />}>at/above floor</Badge>
      )}
      {score.provisionalFloor && <Badge appearance="outline" color="informative" size="small">provisional floor</Badge>}
    </div>
  );
}

export function PromptRegistryPanel() {
  const styles = useStyles();
  const qc = useQueryClient();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [detailFor, setDetailFor] = useState<PromptSummary | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery<PromptsResponse>({
    queryKey: ['llmops-prompts'],
    queryFn: async () => {
      const r = await clientFetch('/api/admin/copilot-quality/prompts');
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `load failed (${r.status})`);
      return j as PromptsResponse;
    },
  });

  if (q.isLoading) {
    return (
      <Skeleton aria-label="Loading prompt registry">
        <div className={styles.cards}>
          {[0, 1, 2].map((i) => <SkeletonItem key={i} style={{ height: '180px', borderRadius: tokens.borderRadiusLarge }} />)}
        </div>
      </Skeleton>
    );
  }
  if (q.isError) {
    return (
      <MessageBar intent="error"><MessageBarBody>
        <MessageBarTitle>Could not load the prompt registry</MessageBarTitle>{(q.error as Error)?.message}
      </MessageBarBody></MessageBar>
    );
  }

  const data = q.data!;

  // FLAG0 kill-switch — OFF hides the tab body behind a guided notice (no roll).
  if (data.flagEnabled === false) {
    return (
      <MessageBar intent="info" layout="multiline"><MessageBarBody>
        <MessageBarTitle>Prompts tab is turned off</MessageBarTitle>
        The <code>n13-prompt-registry</code> runtime flag is currently OFF. Registered prompts, their approval
        history, and the runtime that serves the active version are untouched; only this authoring view is hidden.
        Re-enable it under{' '}
        <NextLink href="/admin/runtime-flags" legacyBehavior><FluentLink>Runtime flags</FluentLink></NextLink>.
      </MessageBarBody></MessageBar>
    );
  }

  return (
    <div className={styles.root}>
      {!data.evaluatorConfigured && (
        <HonestGate gateId="svc-copilot-evaluator" surface="Prompts — publish requests an eval run" onResolved={() => q.refetch()} />
      )}
      <div className={styles.toolbar}>
        <div className={styles.badges}>
          <DocumentBulletList24Regular />
          <Subtitle2>Prompt registry</Subtitle2>
          <Caption1 className={styles.muted}>semver&apos;d versions · real eval scores · audited approvals</Caption1>
        </div>
        <div className={styles.badges}>
          <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={() => q.refetch()} disabled={q.isFetching}>Refresh</Button>
          <Button appearance="primary" icon={<Add20Regular />} onClick={() => setRegisterOpen(true)}>Register prompt</Button>
        </div>
      </div>

      {error && <MessageBar intent="warning" layout="multiline"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {note && <MessageBar intent="success"><MessageBarBody>{note}</MessageBarBody></MessageBar>}

      {data.prompts.length === 0 ? (
        <EmptyState
          icon={<DocumentBulletList24Regular />}
          title="No prompts registered yet"
          body={
            'Register a prompt to version it. Each publish mints the next semver and asks the copilot-evaluator ' +
            'Function — the same harness the Answer quality tab scores — to grade it against that surface’s golden ' +
            'eval set. A version can only become active once a human approves it (audited), and never below the ' +
            'surface’s quality floor without an explicit, recorded override.'
          }
          primaryAction={{ label: 'Register prompt', onClick: () => setRegisterOpen(true) }}
          secondaryAction={{ label: 'Runtime flags', href: '/admin/runtime-flags' }}
        />
      ) : (
        <div className={styles.cards}>
          {data.prompts.map((p) => (
            <div key={p.promptId} className={styles.card}>
              <div className={styles.sectionHead}>
                <TargetArrow24Regular />
                <Subtitle2>{p.label}</Subtitle2>
              </div>
              <div className={styles.badges}>
                <Badge appearance="outline" size="small" className={styles.mono}>{p.promptId}</Badge>
                <Badge appearance="tint" color="brand" size="small">surface: {p.surface}</Badge>
                <Badge appearance="outline" size="small">{p.versionCount} version{p.versionCount === 1 ? '' : 's'}</Badge>
                {p.activeVersion
                  ? <Badge appearance="filled" color="success" size="small">active v{p.activeVersion}</Badge>
                  : <Badge appearance="tint" color="informative" size="small">no active version</Badge>}
                {p.pendingApproval && p.latestVersion && (
                  <Badge appearance="tint" color="warning" size="small">v{p.latestVersion} awaiting approval</Badge>
                )}
              </div>
              {p.description && <Body1 className={styles.muted}>{p.description}</Body1>}
              <ScoreBadges score={p.activeScore} />
              <Caption1 className={styles.muted}>
                owner {p.owner}
                {p.activeApproval
                  ? ` · approved by ${p.activeApproval.approvedBy} on ${new Date(p.activeApproval.approvedAt).toLocaleDateString()}${p.activeApproval.overrodeFloor ? ' (floor override)' : ''}`
                  : ''}
              </Caption1>
              <div className={styles.badges}>
                <Button size="small" appearance="secondary" onClick={() => { setNote(null); setError(null); setDetailFor(p); }}>
                  Versions &amp; approvals
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {registerOpen && (
        <RegisterPromptDialog
          onClose={() => setRegisterOpen(false)}
          onDone={(msg) => { setNote(msg); setError(null); qc.invalidateQueries({ queryKey: ['llmops-prompts'] }); }}
          onError={(msg) => setError(msg)}
        />
      )}
      {detailFor && (
        <PromptVersionsDialog
          summary={detailFor}
          evaluatorConfigured={data.evaluatorConfigured}
          onClose={() => setDetailFor(null)}
          onDone={(msg) => { setNote(msg); setError(null); qc.invalidateQueries({ queryKey: ['llmops-prompts'] }); }}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  );
}

// ── Register dialog ──────────────────────────────────────────────────────────

function RegisterPromptDialog({
  onClose, onDone, onError,
}: { onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void }) {
  const styles = useStyles();
  const [promptId, setPromptId] = useState('');
  const [surface, setSurface] = useState('help');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      const r = await clientFetch('/api/admin/copilot-quality/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId, surface, label: label || promptId, description, template }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `register failed (${r.status})`);
      return j;
    },
    onSuccess: () => { onDone(`Prompt "${promptId}" registered at v1.0.0 (draft). Publish it to request an eval run.`); onClose(); },
    onError: (e) => onError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={styles.wide}>
        <DialogBody>
          <DialogTitle>Register a prompt</DialogTitle>
          <DialogContent>
            <div className={styles.form}>
              <Field label="Prompt id" hint="Stable key, e.g. help-system-prompt. Letters, digits, dot, dash, underscore.">
                <Input value={promptId} onChange={(_, d) => setPromptId(d.value)} />
              </Field>
              <Field label="Copilot surface" hint="Selects the golden eval set that scores this prompt (content/evals/<surface>.jsonl).">
                <Dropdown
                  value={surface}
                  selectedOptions={[surface]}
                  onOptionSelect={(_, d) => setSurface(String(d.optionValue))}
                >
                  {['help', 'deploy-planner', 'lakehouse', 'kql-database', 'data-agent', 'cost', 'health', 'report', 'rbac', 'eventstream'].map((s) => (
                    <Option key={s} value={s}>{s}</Option>
                  ))}
                </Dropdown>
              </Field>
              <Field label="Label"><Input value={label} onChange={(_, d) => setLabel(d.value)} /></Field>
              <Field label="Description"><Input value={description} onChange={(_, d) => setDescription(d.value)} /></Field>
              <Field label="Prompt text (v1.0.0)">
                <Textarea resize="vertical" rows={8} value={template} onChange={(_, d) => setTemplate(d.value)} />
              </Field>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button
              appearance="primary"
              icon={save.isPending ? <Spinner size="tiny" /> : <Add20Regular />}
              disabled={!promptId.trim() || !template.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Register
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ── Versions + approvals dialog ──────────────────────────────────────────────

function PromptVersionsDialog({
  summary, evaluatorConfigured, onClose, onDone, onError,
}: {
  summary: PromptSummary;
  evaluatorConfigured: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const styles = useStyles();
  const qc = useQueryClient();
  const [template, setTemplate] = useState('');
  const [bump, setBump] = useState<'major' | 'minor' | 'patch'>('minor');
  const [notes, setNotes] = useState('');
  const [override, setOverride] = useState(false);

  const detail = useQuery<{ ok: boolean; prompt: PromptSummary; versions: PromptVersion[] }>({
    queryKey: ['llmops-prompt', summary.promptId],
    queryFn: async () => {
      const r = await clientFetch(`/api/admin/copilot-quality/prompts/${encodeURIComponent(summary.promptId)}`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `load failed (${r.status})`);
      return j;
    },
  });

  const act = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const r = await clientFetch(`/api/admin/copilot-quality/prompts/${encodeURIComponent(summary.promptId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `action failed (${r.status})`);
      return j;
    },
    onSuccess: (j) => {
      onDone(String(j?.note || 'Done.'));
      qc.invalidateQueries({ queryKey: ['llmops-prompt', summary.promptId] });
    },
    onError: (e) => onError(e instanceof Error ? e.message : String(e)),
  });

  const versions = detail.data?.versions ?? [];

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={styles.wide}>
        <DialogBody>
          <DialogTitle>{summary.label} — versions &amp; approvals</DialogTitle>
          <DialogContent>
            <div className={styles.root}>
              {detail.isLoading && <Spinner size="tiny" label="Loading versions…" labelPosition="after" />}
              {detail.isError && (
                <MessageBar intent="error"><MessageBarBody>{(detail.error as Error)?.message}</MessageBarBody></MessageBar>
              )}

              {versions.length > 0 && (
                <Table size="small" aria-label="Prompt versions">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Version</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Eval score</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {versions.map((v) => (
                      <TableRow key={v.version}>
                        <TableCell>
                          <div className={styles.badges}>
                            <Text className={styles.mono}>v{v.version}</Text>
                            {detail.data?.prompt.activeVersion === v.version && (
                              <Badge appearance="filled" color="success" size="small">active</Badge>
                            )}
                          </div>
                          <Caption1 className={styles.muted}>{v.createdBy} · {new Date(v.createdAt).toLocaleDateString()}</Caption1>
                        </TableCell>
                        <TableCell>
                          <Badge appearance="tint" size="small" color={STATUS_COLOR[v.status]}>{v.status}</Badge>
                        </TableCell>
                        <TableCell><ScoreBadges score={v.evalScore} /></TableCell>
                        <TableCell>
                          <div className={styles.badges}>
                            <Tooltip content="Stamp this prompt’s surface’s newest REAL evaluator run onto this version." relationship="label">
                              <Button size="small" appearance="secondary" icon={<ArrowSync20Regular />}
                                disabled={act.isPending}
                                onClick={() => act.mutate({ action: 'refresh-score', version: v.version })}>
                                Refresh score
                              </Button>
                            </Tooltip>
                            {v.status !== 'approved' && (
                              <Button size="small" appearance="primary" icon={<CheckmarkCircle20Regular />}
                                disabled={act.isPending}
                                onClick={() => act.mutate({ action: 'approve', version: v.version, overrideBelowFloor: override })}>
                                Approve
                              </Button>
                            )}
                            {v.approval && detail.data?.prompt.activeVersion !== v.version && (
                              <Button size="small" appearance="secondary" icon={<ArrowUndo20Regular />}
                                disabled={act.isPending}
                                onClick={() => act.mutate({ action: 'rollback', version: v.version })}>
                                Roll back to
                              </Button>
                            )}
                          </div>
                          {v.evalGate && (
                            <Caption1 className={styles.muted}>{v.evalGate.remediation}</Caption1>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              <Switch
                checked={override}
                onChange={(_, d) => setOverride(!!d.checked)}
                label="Approve even when the version is below its quality floor (recorded in the audit trail as a floor override)"
              />

              <div className={styles.card}>
                <div className={styles.sectionHead}><Send20Regular /><Subtitle2>Publish a new version</Subtitle2></div>
                <Caption1 className={styles.muted}>
                  Publishing mints the next semver and asks the copilot-evaluator Function to grade it against the
                  <strong> {summary.surface} </strong> golden set — the same harness and the same floors the Answer
                  quality tab reports. No separate pipeline is run.
                  {!evaluatorConfigured && ' The evaluator Function is not wired in this deployment, so the version will publish unscored (and stay unapprovable) until a real run lands.'}
                </Caption1>
                <Field label="Prompt text">
                  <Textarea resize="vertical" rows={7} value={template} onChange={(_, d) => setTemplate(d.value)} />
                </Field>
                <Field label="Bump">
                  <Dropdown value={bump} selectedOptions={[bump]} onOptionSelect={(_, d) => setBump(String(d.optionValue) as 'major' | 'minor' | 'patch')}>
                    <Option value="patch">patch</Option>
                    <Option value="minor">minor</Option>
                    <Option value="major">major</Option>
                  </Dropdown>
                </Field>
                <Field label="Changelog note"><Input value={notes} onChange={(_, d) => setNotes(d.value)} /></Field>
                <div className={styles.badges}>
                  <Button appearance="primary" icon={act.isPending ? <Spinner size="tiny" /> : <Send20Regular />}
                    disabled={!template.trim() || act.isPending}
                    onClick={() => act.mutate({ action: 'publish', template, bump, notes })}>
                    Publish &amp; request eval
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
          <DialogActions><Button appearance="secondary" onClick={onClose}>Close</Button></DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
