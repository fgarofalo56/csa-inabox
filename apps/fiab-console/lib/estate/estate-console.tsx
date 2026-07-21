'use client';

/**
 * WS-8 — Estate builder console.
 *
 * Hosts both burn-the-box surfaces behind one page:
 *   • "Describe it" (8.1) — one NL prompt → a reviewable estate plan-model
 *     (dry-run + diff), then Approve → build the whole chain via the real Weave
 *     bridges.
 *   • "Draw it" (8.2) — the One-Canvas authoring surface; Publish compiles the
 *     topology to the SAME plan-model, reviewed + executed by the SAME panel.
 *
 * The dry-run → approve → apply flow reuses one shared review panel so the diff
 * a user approves is exactly what runs (no-vaporware.md). A target workspace is
 * picked once (the estate's items land there).
 */

import { useCallback, useState } from 'react';
import {
  TabList, Tab, Textarea, Button, Select, Field, Card, Badge, Spinner,
  Subtitle2, Body1, Caption1, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Link as FluentLink, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Sparkle20Regular, Rocket20Regular, CheckmarkCircle16Filled,
  ErrorCircle16Filled, SubtractCircle16Regular, ArrowRight16Regular, Wrench16Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { clientFetch } from '@/lib/client-fetch';
import { useWorkspaces } from '@/lib/editors/phase3/workspace-picker';
import { OneCanvas } from '@/lib/estate/one-canvas';
import type { EstatePlan, EstateDiff, EstateValidation } from '@/lib/estate/estate-plan-model';
import type { EstateExecResult } from '@/lib/estate/estate-executor';

const useStyles = makeStyles({
  grid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minHeight: 0 },
  promptRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  reviewCard: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM },
  opRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2, minWidth: 0,
  },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

const EXAMPLE = 'Build a sales analytics estate: a lakehouse, promote it to a silver layer, build a semantic model and a report, publish an API, and add a data agent grounded on it.';

export function EstateConsole() {
  const s = useStyles();
  const { workspaces, loading: wsLoading } = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [tab, setTab] = useState<'describe' | 'draw'>('describe');

  const [prompt, setPrompt] = useState('');
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<EstatePlan | null>(null);
  const [diff, setDiff] = useState<EstateDiff | null>(null);
  const [validation, setValidation] = useState<EstateValidation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [errorCode, setErrorCode] = useState<string | null>(null);

  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<EstateExecResult | null>(null);

  const resolvedWs = workspaceId || workspaces?.[0]?.id || '';

  const runPlan = useCallback(async () => {
    if (!prompt.trim()) return;
    setPlanning(true); setError(null); setErrorCode(null); setResult(null); setPlan(null); setDiff(null); setValidation(null);
    try {
      const r = await clientFetch('/api/estate/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), workspaceId: resolvedWs }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'Failed to plan the estate.'); setErrorCode(j.code || null); return; }
      setPlan(j.plan); setDiff(j.diff); setValidation(j.validation);
    } catch (e: any) {
      setError(e?.message || 'Failed to plan the estate.');
    } finally {
      setPlanning(false);
    }
  }, [prompt, resolvedWs]);

  // Called by the One-Canvas Publish — compiled plan enters the same review flow.
  const onCanvasPublish = useCallback(async (compiled: EstatePlan) => {
    setError(null); setResult(null);
    setPlan(compiled);
    // Derive the diff/validation client-side for the review panel.
    const [{ planDiff, validatePlan }] = await Promise.all([import('@/lib/estate/estate-plan-model')]);
    setDiff(planDiff(compiled));
    setValidation(validatePlan(compiled));
  }, []);

  const execute = useCallback(async () => {
    if (!plan || !resolvedWs) return;
    setExecuting(true); setError(null); setErrorCode(null); setResult(null);
    try {
      const r = await clientFetch('/api/estate/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan, workspaceId: resolvedWs }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'Failed to build the estate.'); return; }
      setResult(j.result);
    } catch (e: any) {
      setError(e?.message || 'Failed to build the estate.');
    } finally {
      setExecuting(false);
    }
  }, [plan, resolvedWs]);

  const hasErrors = !!validation && !validation.ok;

  return (
    <PageShell
      title="Estate builder"
      subtitle="Describe a full data estate in one prompt, or draw it on one canvas — Loom plans a reviewable chain of real Weave bridges and builds it end to end."
    >
      <div className={s.grid}>
        <Field label="Target workspace" hint="The estate's items are created here.">
          <Select value={resolvedWs} onChange={(_, d) => setWorkspaceId(d.value)} disabled={wsLoading}>
            {wsLoading && <option>Loading…</option>}
            {(workspaces || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'describe' | 'draw')}>
          <Tab value="describe" icon={<Sparkle20Regular />}>Describe it</Tab>
          <Tab value="draw" icon={<Rocket20Regular />}>Draw it</Tab>
        </TabList>

        {tab === 'describe' && (
          <div className={s.promptRow}>
            <Field label="Describe the estate to build" hint="One prompt. Loom emits a reviewable plan of real Weave bridges.">
              <Textarea
                value={prompt}
                onChange={(_, d) => setPrompt(d.value)}
                placeholder={EXAMPLE}
                rows={3}
                resize="vertical"
              />
            </Field>
            <div className={s.actions}>
              <Button appearance="primary" icon={<Sparkle20Regular />} onClick={runPlan} disabled={planning || !prompt.trim()}>
                {planning ? 'Planning…' : 'Plan the estate'}
              </Button>
              <Button appearance="subtle" onClick={() => setPrompt(EXAMPLE)} disabled={planning}>Use the example</Button>
              {planning && <Spinner size="tiny" />}
            </div>
          </div>
        )}

        {tab === 'draw' && (
          <OneCanvas onPublish={onCanvasPublish} busy={executing} />
        )}

        {error && (
          <MessageBar intent={errorCode === 'no_aoai_deployment' ? 'warning' : 'error'} layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>{errorCode === 'no_aoai_deployment' ? 'Reasoning model not configured' : "Couldn't complete that"}</MessageBarTitle>
              {error}
            </MessageBarBody>
            {errorCode === 'no_aoai_deployment' && (
              <MessageBarActions>
                <Button size="small" icon={<Wrench16Regular />} as="a" href="/admin/gates?gate=svc-model-reasoning-tier">Fix it</Button>
              </MessageBarActions>
            )}
          </MessageBar>
        )}

        {/* Shared review panel — the dry-run diff + approve → build. */}
        {plan && diff && (
          <Card className={s.reviewCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
              <Subtitle2>{plan.title || 'Estate plan'}</Subtitle2>
              <Badge appearance="tint" color="brand">{diff.createCount} create</Badge>
              <Badge appearance="tint" color="informative">{diff.weaveCount} weave</Badge>
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{diff.summary}</Caption1>

            {hasErrors && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Fix the plan before building</MessageBarTitle>
                  {validation!.issues.filter((i) => i.level === 'error').map((i, idx) => <div key={idx}>{i.message}</div>)}
                </MessageBarBody>
              </MessageBar>
            )}

            {/* The dry-run diff (before = nothing exists → after = these items). */}
            {diff.ops.map((op) => {
              const node = result?.plan.nodes.find((n) => n.id === op.nodeId);
              const status = node?.status;
              return (
                <div key={op.nodeId} className={s.opRow}>
                  {status === 'created' && <CheckmarkCircle16Filled style={{ color: tokens.colorStatusSuccessForeground1 }} />}
                  {status === 'failed' && <ErrorCircle16Filled style={{ color: tokens.colorStatusDangerForeground1 }} />}
                  {status === 'skipped' && <SubtractCircle16Regular style={{ color: tokens.colorNeutralForeground3 }} />}
                  <Badge appearance="outline" color={op.op === 'create' ? 'brand' : 'informative'}>{op.op}</Badge>
                  <Body1><strong>{op.title}</strong></Body1>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>({op.itemType})</Caption1>
                  {op.op === 'weave' && op.fromTitle && (
                    <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                      <ArrowRight16Regular /> {op.actionLabel} from {op.fromTitle}
                    </Caption1>
                  )}
                  {node?.resultLink && (
                    <FluentLink href={node.resultLink} style={{ marginLeft: 'auto' }}>Open</FluentLink>
                  )}
                  {node?.error && <Caption1 style={{ color: tokens.colorStatusDangerForeground1, width: '100%' }}>{node.error}</Caption1>}
                </div>
              );
            })}

            <div className={s.actions}>
              <Button
                appearance="primary"
                icon={<Rocket20Regular />}
                onClick={execute}
                disabled={executing || hasErrors || !resolvedWs}
              >
                {executing ? 'Building…' : 'Approve & build the estate'}
              </Button>
              {executing && <Spinner size="tiny" />}
            </div>

            {result && (
              <MessageBar intent={result.ok ? 'success' : 'warning'} layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>{result.ok ? 'Estate built' : 'Estate partially built'}</MessageBarTitle>
                  {result.summary}
                </MessageBarBody>
              </MessageBar>
            )}
          </Card>
        )}
      </div>
    </PageShell>
  );
}
