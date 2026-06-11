'use client';

/**
 * NotebookImportWizard — Learning-Hub action that imports a prebuilt notebook
 * into a workspace, with or without seeded ADLS sample data.
 *
 * Mirrors the app-install dialog (app/apps/[id]/page.tsx): a workspace
 * Dropdown loaded from /api/workspaces, a Dropdown to pick which prebuilt
 * notebook (driven by GET /api/learn/notebook-import — real registry data),
 * and a fixed two-choice RadioGroup for sample data (no freeform config). On
 * submit it POSTs /api/learn/notebook-import and renders the returned
 * ProvisionReport with the same per-step gate / step-log affordances.
 *
 * Real backend end-to-end: the route calls the existing provisioning engine
 * which dispatches the notebook provisioner (Synapse Spark → Databricks →
 * Fabric-opt-in) and, when sample data is chosen, the lakehouse provisioner
 * (writes real sampleRows CSVs to the DLZ ADLS Gen2 container).
 */

import * as React from 'react';
import Link from 'next/link';
import {
  Button, Badge, Caption1, Field, Dropdown, Option, RadioGroup, Radio,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, makeStyles, tokens,
} from '@fluentui/react-components';
import { NotebookAdd24Regular } from '@fluentui/react-icons';

interface WorkspaceLite { id: string; name: string }
interface NotebookOption {
  bundleId: string;
  bundleLabel: string;
  notebookDisplayName: string;
  itemType: string;
  description: string;
  cellCount: number;
  hasSampleData: boolean;
}
interface ProvisionStep {
  itemType: string;
  displayName: string;
  cosmosItemId: string;
  result: {
    status: 'created' | 'exists' | 'skipped' | 'remediation' | 'failed';
    resourceId?: string;
    error?: string;
    gate?: { reason: string; remediation: string; link?: string };
    steps?: string[];
  };
}
interface ProvisionReport {
  outcome: 'all-created' | 'partial' | 'all-remediation' | 'skipped';
  mode: 'shared' | 'dedicated';
  steps: ProvisionStep[];
}
interface ImportResult {
  installed: { itemType: string; id?: string; displayName: string }[];
  provision?: ProvisionReport;
  workspaceId: string;
}

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '420px' },
  nbHint: { color: tokens.colorNeutralForeground3 },
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.5 },
  report: {
    paddingTop: tokens.spacingVerticalM, paddingRight: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM, paddingLeft: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    marginTop: tokens.spacingVerticalL,
  },
  gate: {
    marginTop: '4px', padding: '8px',
    backgroundColor: tokens.colorNeutralBackground3, borderRadius: '4px',
  },
});

/** Read an import response as JSON, tolerating a gateway HTML 502/504 page
 * the way the app-install dialog does (long real-Azure provisioning can
 * exceed the edge timeout). */
async function readJsonOrGate(r: Response): Promise<any> {
  const text = await r.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : { ok: false, error: `Empty response (HTTP ${r.status}).` };
  } catch {
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(text);
    if (looksHtml || r.status === 502 || r.status === 504) {
      return {
        ok: false,
        error:
          `The import exceeded the gateway timeout (HTTP ${r.status}) while provisioning live Azure services. ` +
          'The notebook was created in the workspace and provisioning may still be finishing — refresh the workspace in a minute.',
      };
    }
    return { ok: false, error: `Unexpected non-JSON response (HTTP ${r.status}): ${text.slice(0, 200)}` };
  }
}

export function NotebookImportWizard(): React.ReactElement {
  const s = useStyles();
  const [open, setOpen] = React.useState(false);
  const [workspaces, setWorkspaces] = React.useState<WorkspaceLite[]>([]);
  const [notebooks, setNotebooks] = React.useState<NotebookOption[]>([]);
  const [pickedWs, setPickedWs] = React.useState('');
  const [pickedNbKey, setPickedNbKey] = React.useState(''); // `${bundleId}::${notebookDisplayName}`
  const [sampleChoice, setSampleChoice] = React.useState<'with' | 'without'>('with');
  const [loading, setLoading] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);

  const pickedNb = React.useMemo(
    () => notebooks.find((n) => `${n.bundleId}::${n.notebookDisplayName}` === pickedNbKey),
    [notebooks, pickedNbKey],
  );

  // Load workspaces + prebuilt notebook catalog when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    if (workspaces.length && notebooks.length) return;
    setLoading(true);
    Promise.all([
      fetch('/api/workspaces').then((r) => r.json()).catch(() => null),
      fetch('/api/learn/notebook-import').then((r) => r.json()).catch(() => null),
    ])
      .then(([wsData, nbData]) => {
        const wsList: WorkspaceLite[] = Array.isArray(wsData) ? wsData : (wsData?.workspaces || []);
        setWorkspaces(wsList);
        if (wsList.length === 1) setPickedWs(wsList[0].id);
        const nbList: NotebookOption[] = nbData?.notebooks || [];
        setNotebooks(nbList);
        if (nbList.length && !pickedNbKey) {
          setPickedNbKey(`${nbList[0].bundleId}::${nbList[0].notebookDisplayName}`);
        }
      })
      .finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the sample-data choice valid: notebooks whose bundle has no sample
  // data can only import "without".
  React.useEffect(() => {
    if (pickedNb && !pickedNb.hasSampleData) setSampleChoice('without');
  }, [pickedNb]);

  const doImport = async () => {
    if (!pickedWs || !pickedNb) return;
    setImporting(true); setErr(null); setResult(null);
    try {
      const r = await fetch('/api/learn/notebook-import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: pickedWs,
          bundleId: pickedNb.bundleId,
          notebookDisplayName: pickedNb.notebookDisplayName,
          withSampleData: sampleChoice === 'with' && pickedNb.hasSampleData,
        }),
      });
      const j = await readJsonOrGate(r);
      if (!r.ok || !j.ok) {
        setErr(j?.error || `HTTP ${r.status}`);
      } else {
        setResult({ installed: j.installed || [], provision: j.provision, workspaceId: j.workspaceId });
        setOpen(false);
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <Button appearance="primary" icon={<NotebookAdd24Regular />} onClick={() => setOpen(true)}>
        Import notebook
      </Button>

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Import a prebuilt notebook</DialogTitle>
            <DialogContent>
              {loading ? (
                <Spinner label="Loading workspaces + notebooks…" />
              ) : (
                <div className={s.form}>
                  <Caption1 className={s.intro}>
                    Imports a ready-made Spark / Databricks notebook into a workspace.
                    Choose <strong>with sample data</strong> to also seed the matching
                    lakehouse tables into ADLS so the notebook runs against real data.
                  </Caption1>

                  <Field label="Workspace" required>
                    <Dropdown
                      placeholder="Pick a workspace"
                      selectedOptions={pickedWs ? [pickedWs] : []}
                      value={workspaces.find((w) => w.id === pickedWs)?.name || ''}
                      onOptionSelect={(_, d) => setPickedWs(d.optionValue || '')}
                    >
                      {workspaces.map((w) => (
                        <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  {workspaces.length === 0 && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        You don&apos;t have any workspaces yet. Create one at{' '}
                        <Link href="/workspaces">/workspaces</Link> first.
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  <Field label="Notebook" required hint="Prebuilt notebooks from the app content bundles.">
                    <Dropdown
                      placeholder="Pick a notebook"
                      selectedOptions={pickedNbKey ? [pickedNbKey] : []}
                      value={pickedNb ? `${pickedNb.notebookDisplayName} · ${pickedNb.bundleLabel}` : ''}
                      onOptionSelect={(_, d) => setPickedNbKey(d.optionValue || '')}
                    >
                      {notebooks.map((n) => {
                        const key = `${n.bundleId}::${n.notebookDisplayName}`;
                        return (
                          <Option key={key} value={key} text={`${n.notebookDisplayName} · ${n.bundleLabel}`}>
                            {n.notebookDisplayName} · {n.bundleLabel} ({n.cellCount} cells)
                          </Option>
                        );
                      })}
                    </Dropdown>
                  </Field>
                  {pickedNb && (
                    <Caption1 className={s.nbHint}>
                      {pickedNb.description}
                      {' '}
                      <Badge appearance="outline" size="small">{pickedNb.itemType}</Badge>
                    </Caption1>
                  )}

                  <Field label="Sample data" required>
                    <RadioGroup
                      value={sampleChoice}
                      onChange={(_, d) => setSampleChoice(d.value as 'with' | 'without')}
                    >
                      <Radio
                        value="with"
                        disabled={!pickedNb?.hasSampleData}
                        label="With sample data — also seed the matching lakehouse tables into ADLS Delta"
                      />
                      <Radio value="without" label="Without sample data — import the notebook only" />
                    </RadioGroup>
                  </Field>
                  {pickedNb && !pickedNb.hasSampleData && (
                    <MessageBar intent="info">
                      <MessageBarBody>
                        This notebook&apos;s bundle ships no seedable sample tables — it imports without sample data.
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  {err && (
                    <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>
                  )}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button
                appearance="primary"
                onClick={doImport}
                disabled={!pickedWs || !pickedNb || importing}
              >
                {importing ? 'Importing…' : 'Import'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {result && (
        <div className={s.report} data-testid="notebook-import-report">
          <MessageBar intent="success">
            <MessageBarTitle>Imported {result.installed.length} item(s)</MessageBarTitle>
            <MessageBarBody>
              {result.installed.map((it, i) => (
                <div key={i} style={{ fontSize: 13, marginTop: 4 }}>
                  <Badge appearance="outline" color="brand">{it.itemType}</Badge>{' '}
                  {it.id ? (
                    <Link href={`/items/${it.itemType}/${it.id}`}>{it.displayName}</Link>
                  ) : (
                    <span>{it.displayName}</span>
                  )}
                </div>
              ))}
            </MessageBarBody>
          </MessageBar>

          {result.provision && (
            <div style={{ marginTop: tokens.spacingVerticalM }}>
              <MessageBar
                intent={result.provision.outcome === 'all-created' ? 'success'
                  : result.provision.outcome === 'all-remediation' ? 'warning'
                  : result.provision.outcome === 'skipped' ? 'info' : 'warning'}
              >
                <MessageBarTitle>
                  Provisioning — {result.provision.outcome} ({result.provision.mode} mode)
                </MessageBarTitle>
                <MessageBarBody>
                  {result.provision.steps.map((step, i) => (
                    <div key={i} style={{ fontSize: 13, marginTop: 8, paddingTop: 8, borderTop: i > 0 ? `1px solid ${tokens.colorNeutralStroke3}` : 'none' }}>
                      <Badge appearance="filled" color={
                        step.result.status === 'created' || step.result.status === 'exists' ? 'success'
                          : step.result.status === 'remediation' ? 'warning'
                          : step.result.status === 'skipped' ? 'subtle' : 'danger'
                      }>
                        {step.result.status}
                      </Badge>{' '}
                      <strong>{step.itemType}</strong> — {step.displayName}
                      {step.result.resourceId && (
                        <Caption1 style={{ display: 'block', fontFamily: 'monospace', color: tokens.colorNeutralForeground3 }}>
                          Azure id: {step.result.resourceId}
                        </Caption1>
                      )}
                      {step.result.gate && (
                        <div className={s.gate}>
                          <div style={{ fontWeight: 600 }}>Remediation required: {step.result.gate.reason}</div>
                          <div style={{ marginTop: 4 }}>{step.result.gate.remediation}</div>
                          {step.result.gate.link && (
                            <a href={step.result.gate.link} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 4 }}>
                              Open admin step →
                            </a>
                          )}
                        </div>
                      )}
                      {step.result.error && !step.result.gate && (
                        <div style={{ marginTop: 4, color: tokens.colorPaletteRedForeground1, fontSize: 12 }}>
                          {step.result.error}
                        </div>
                      )}
                      {(step.result.steps?.length || 0) > 0 && (
                        <details style={{ marginTop: 4 }}>
                          <summary style={{ cursor: 'pointer', fontSize: 12, color: tokens.colorNeutralForeground3 }}>
                            Step log ({step.result.steps?.length})
                          </summary>
                          <ul style={{ marginTop: 4, marginLeft: 16, fontSize: 12, color: tokens.colorNeutralForeground2 }}>
                            {step.result.steps?.map((line, ix) => <li key={ix}>{line}</li>)}
                          </ul>
                        </details>
                      )}
                    </div>
                  ))}
                </MessageBarBody>
              </MessageBar>
            </div>
          )}
        </div>
      )}
    </>
  );
}
