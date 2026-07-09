'use client';

/**
 * ModelHealthPane — Copilot autonomous model-health scan + apply-fix (FGC-22).
 *
 * "Scan model health" runs a Best-Practice-Analyzer-style rule set over the
 * Loom-native model (relationships, measures, date marks, unused columns) and
 * Azure OpenAI proposes measure descriptions. Fixable findings are selected into
 * a review/diff, then applied through the SAME checkpoint/approval flow the
 * NL-structure Copilot uses — a checkpoint is captured before any write so the
 * change is reversible. NO api.powerbi.com / api.fabric.microsoft.com anywhere.
 *
 * web3-ui: Fluent v9 + Loom tokens only. no-vaporware: real scan/apply routes,
 * honest AOAI gate when descriptions can't be generated.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  makeStyles, tokens, shorthands,
  Subtitle2, Body1, Caption1, Card, Button, Spinner, Badge, Checkbox, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import {
  Stethoscope20Regular, CheckmarkCircle20Regular, Wrench20Regular, History20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

interface HealthFix {
  kind: 'add-relationship' | 'mark-date-table' | 'set-measure-description';
  [k: string]: unknown;
}
interface HealthFinding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  id: string;
  title: string;
  detail: string;
  fix?: HealthFix;
}
interface Checkpoint { id: string; label: string; createdAt: string; stats?: { measures: number; relationships: number } }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', ...shorthands.gap(tokens.spacingVerticalL) },
  intro: {
    display: 'flex', flexDirection: 'column', ...shorthands.gap(tokens.spacingVerticalXS),
    ...shorthands.padding(tokens.spacingVerticalL),
    ...shorthands.borderRadius(tokens.borderRadiusXLarge),
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorNeutralBackground2})`,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', ...shorthands.gap(tokens.spacingHorizontalS) },
  findingCard: { display: 'flex', flexDirection: 'column', ...shorthands.gap(tokens.spacingVerticalXS), ...shorthands.padding(tokens.spacingVerticalM) },
  findingHead: { display: 'flex', alignItems: 'center', ...shorthands.gap(tokens.spacingHorizontalS) },
  findingBody: { display: 'flex', alignItems: 'flex-start', ...shorthands.gap(tokens.spacingHorizontalS) },
  list: { display: 'flex', flexDirection: 'column', ...shorthands.gap(tokens.spacingVerticalS) },
  cpRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...shorthands.gap(tokens.spacingHorizontalS), ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS) },
  spacer: { flex: 1 },
});

const SEVERITY_BADGE: Record<string, 'danger' | 'warning' | 'informative'> = {
  error: 'danger', warning: 'warning', info: 'informative',
};

function fixSummary(fix: HealthFix): string {
  if (fix.kind === 'add-relationship') return `Add relationship ${fix.fromTable}[${fix.fromColumn}] → ${fix.toTable}[${fix.toColumn}] (${fix.cardinality})`;
  if (fix.kind === 'mark-date-table') return `Mark '${fix.table}' as the date table on [${fix.dateColumn}]`;
  if (fix.kind === 'set-measure-description') return `Set description on [${fix.measure}]: "${String(fix.description).slice(0, 80)}"`;
  return 'Apply fix';
}

export function ModelHealthPane({ id }: { id: string }) {
  const cs = useStyles();
  const [scanning, setScanning] = useState(false);
  const [findings, setFindings] = useState<HealthFinding[] | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string; detail: string } | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState<{ ok: boolean; text: string; applied?: string[]; skipped?: string[] } | null>(null);

  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadCheckpoints = useCallback(async () => {
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/model-health?action=checkpoints`);
      const j = await r.json();
      setCheckpoints(j.ok && Array.isArray(j.checkpoints) ? j.checkpoints : []);
    } catch { setCheckpoints([]); }
  }, [id]);

  useEffect(() => { void loadCheckpoints(); }, [loadCheckpoints]);

  const scan = useCallback(async () => {
    setScanning(true); setFindings(null); setScanErr(null); setGate(null); setApplyMsg(null); setSelected({});
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/model-health`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'scan' }),
      });
      const j = await r.json();
      if (!j.ok) { setScanErr(j.error || `HTTP ${r.status}`); return; }
      const f: HealthFinding[] = Array.isArray(j.findings) ? j.findings : [];
      setFindings(f);
      setBackend(j.backend || null);
      if (j.gate) setGate(j.gate);
      // Default-select every fixable finding.
      const sel: Record<string, boolean> = {};
      for (const finding of f) if (finding.fix) sel[finding.id] = true;
      setSelected(sel);
    } catch (e: any) { setScanErr(e?.message || String(e)); }
    finally { setScanning(false); }
  }, [id]);

  const apply = useCallback(async () => {
    if (!findings) return;
    const fixes = findings.filter((f) => f.fix && selected[f.id]).map((f) => f.fix as HealthFix);
    if (fixes.length === 0) return;
    setApplying(true); setApplyMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/model-health`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply', fixes }),
      });
      const j = await r.json();
      if (!j.ok) { setApplyMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setApplyMsg({ ok: true, text: `Applied ${(j.applied || []).length} fix(es). A checkpoint was captured first.`, applied: j.applied, skipped: j.skipped });
      await loadCheckpoints();
      await scan(); // re-scan so the list reflects the applied fixes
    } catch (e: any) { setApplyMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setApplying(false); }
  }, [findings, selected, id, loadCheckpoints, scan]);

  const restore = useCallback(async (checkpointId: string) => {
    setRestoringId(checkpointId);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/model-health`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore', checkpointId }),
      });
      const j = await r.json();
      if (j.ok) { setApplyMsg({ ok: true, text: j.note || 'Restored.' }); await scan(); }
      else setApplyMsg({ ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setApplyMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setRestoringId(null); }
  }, [id, scan]);

  const fixableCount = (findings || []).filter((f) => !!f.fix).length;
  const selectedCount = (findings || []).filter((f) => f.fix && selected[f.id]).length;

  return (
    <div className={cs.root}>
      <div className={cs.intro}>
        <Subtitle2>Model health</Subtitle2>
        <Body1>
          Scan this model for best-practice issues — broken or missing relationships, an unmarked date table,
          measures without descriptions, non-additive measure patterns, and unused columns. Copilot proposes
          fixes; you review and apply them, and a checkpoint is captured first so every change is reversible.
          Runs entirely on the Azure-native model — no Microsoft Fabric or Power BI required.
        </Body1>
      </div>

      <div className={cs.actions}>
        <Button appearance="primary" icon={scanning ? <Spinner size="tiny" /> : <Stethoscope20Regular />} disabled={scanning} onClick={scan}>
          {scanning ? 'Scanning…' : 'Scan model health'}
        </Button>
        {findings && fixableCount > 0 && (
          <Button appearance="secondary" icon={applying ? <Spinner size="tiny" /> : <Wrench20Regular />} disabled={applying || selectedCount === 0} onClick={apply}>
            {applying ? 'Applying…' : `Apply ${selectedCount} fix(es)`}
          </Button>
        )}
        {backend && findings && <Caption1>backend: {backend}</Caption1>}
      </div>

      {scanErr && <MessageBar intent="error"><MessageBarBody>{scanErr}</MessageBarBody></MessageBar>}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Measure descriptions need Azure OpenAI ({gate.missing})</MessageBarTitle>
            {gate.detail}
          </MessageBarBody>
        </MessageBar>
      )}
      {applyMsg && (
        <MessageBar intent={applyMsg.ok ? 'success' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{applyMsg.ok ? 'Fixes applied' : 'Apply failed'}</MessageBarTitle>
            {applyMsg.text}
            {applyMsg.applied && applyMsg.applied.length > 0 && (
              <ul>{applyMsg.applied.map((a, i) => <li key={i}>{a}</li>)}</ul>
            )}
            {applyMsg.skipped && applyMsg.skipped.length > 0 && (
              <div><strong>Skipped:</strong><ul>{applyMsg.skipped.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      {findings && findings.length === 0 && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle><CheckmarkCircle20Regular /> No issues found</MessageBarTitle>
            This model passes every best-practice rule in the scan.
          </MessageBarBody>
        </MessageBar>
      )}

      {findings && findings.length > 0 && (
        <div className={cs.list}>
          {findings.map((f) => (
            <Card key={f.id} className={cs.findingCard}>
              <div className={cs.findingHead}>
                <Badge appearance="tint" color={SEVERITY_BADGE[f.severity] || 'informative'}>{f.severity}</Badge>
                <Subtitle2>{f.title}</Subtitle2>
                <div className={cs.spacer} />
                <Caption1>{f.rule}</Caption1>
              </div>
              <Body1>{f.detail}</Body1>
              {f.fix && (
                <div className={cs.findingBody}>
                  <Checkbox
                    checked={!!selected[f.id]}
                    onChange={(_, d) => setSelected((prev) => ({ ...prev, [f.id]: !!d.checked }))}
                    label={`Fix: ${fixSummary(f.fix)}`}
                  />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <Divider />
      <div className={cs.actions}>
        <History20Regular />
        <Subtitle2>Checkpoints</Subtitle2>
        {Array.isArray(checkpoints) && checkpoints.length > 0 && <Badge appearance="tint" color="informative">{checkpoints.length}</Badge>}
        <div className={cs.spacer} />
        <Button size="small" appearance="subtle" onClick={loadCheckpoints}>Refresh</Button>
      </div>
      {checkpoints === null ? (
        <Spinner size="tiny" label="Loading checkpoints…" labelPosition="after" />
      ) : checkpoints.length === 0 ? (
        <Caption1>No checkpoints yet. One is captured automatically before each apply.</Caption1>
      ) : (
        <div className={cs.list}>
          {checkpoints.map((c) => (
            <Card key={c.id} className={cs.cpRow}>
              <div>
                <Body1>{c.label}</Body1>
                <Caption1>{new Date(c.createdAt).toLocaleString()}{c.stats ? ` · ${c.stats.measures} measures, ${c.stats.relationships} relationships` : ''}</Caption1>
              </div>
              <Button size="small" appearance="secondary" disabled={restoringId === c.id} onClick={() => restore(c.id)}>
                {restoringId === c.id ? 'Restoring…' : 'Restore'}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default ModelHealthPane;
