'use client';
/**
 * PIPELINE AUTO-BIND SURFACES — the states an item can be in while the platform
 * provisions and binds its backing ADF / Synapse pipeline.
 *
 * Extracted from `pipeline-editor-core.tsx` because they are a bounded context
 * of their own (and because the core had crossed the 1500-LOC monolith-creep
 * guard). Everything here is presentational: it renders an auto-bind outcome
 * and calls back. No fetching, no binding logic.
 *
 * The rule these implement — `.claude/rules/auto-bind-by-default.md` §4: *"The
 * editor NEVER opens on a 'bind me first' form. The canvas/designer/grid is the
 * first thing the user sees. If provisioning is still running, show a progress
 * state on the real surface — not a configuration form in its place."*
 *
 * Live (#2942) the centre pane WAS that form: a *"Bind to an existing pipeline"*
 * picker whose dropdown read "No pipelines found" and whose **Bind** button was
 * disabled — a dead end with the whole authoring ribbon inert behind it. So the
 * four surfaces below are deliberately ordered by how much agency the user
 * needs, and only the LAST one is a form:
 *
 *   Progress      auto-bind is running        → spinner on the real surface
 *   Retry         transient (5xx / throttle)  → progress + a real Retry
 *   Rebind        user asked to re-map        → explicit, never the default
 *   Unavailable   a genuine estate gate       → the reason + Try again, with
 *                                               the picker beneath as the Fix-it
 *
 * …plus one that belongs to the BOUND branch rather than the unbound one:
 *
 *   SeedIncomplete the object EXISTS and is bound but its authored content
 *                  could not be written — an empty pipeline that must never be
 *                  presented as complete (#3549).
 */
import {
  Badge, Body1, Button, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  Spinner, Subtitle2, makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Link20Regular } from '@fluentui/react-icons';
import { PipelineDesigner } from '@/lib/components/pipeline/pipeline-designer';
import { extractActivities } from '@/lib/components/pipeline/pipeline-dag-view';
import { paramsFromSpec, varsFromSpec, type PipelineSpec } from '@/lib/components/pipeline/types';

const useStyles = makeStyles({
  // Full width, mirroring the bound-state canvas, so the authored graph is
  // readable rather than squeezed into a form column.
  graph: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0, maxWidth: '100%' },
  graphHead: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
});

/**
 * The `autoBind` block the bind GET returns (`lib/azure/auto-bind →
 * autoBindWireStatus`). Declared structurally rather than imported because
 * `auto-bind.ts` is a SERVER module (it reaches Azure control planes) and this
 * is a client component.
 */
export interface AutoBindWire {
  status: 'bound' | 'retry' | 'unavailable' | 'unsupported';
  via?: 'created' | 'attached' | 'existing' | 'recreated';
  backingName?: string;
  sourceName?: string;
  sanitized?: boolean;
  nameDrift?: boolean;
  /** True when the item's authored content was written into the backing object. */
  seeded?: boolean;
  /**
   * Set when authored content EXISTED but could not be written. The pipeline is
   * real and bound but EMPTY, so the editor must not present it as complete.
   * These two fields were missing from this interface while the server was
   * already sending them, which is how the honest-failure channel stayed dead.
   */
  seedError?: string;
  reason?: string;
  missing?: string;
  retryable?: boolean;
}

const actionRow: React.CSSProperties = {
  display: 'flex',
  gap: tokens.spacingHorizontalS,
  marginTop: tokens.spacingVerticalS,
  flexWrap: 'wrap',
};

/**
 * Auto-bind is running. This is PROGRESS, not a gate — the platform is creating
 * or attaching the backing pipeline during this very fetch, so there is nothing
 * for the user to do and nothing to configure.
 */
export function AutoBindProgress({ containerLabel, rebinding }: {
  containerLabel: string;
  rebinding: boolean;
}) {
  return (
    <>
      <MessageBar intent="info" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>
            {rebinding ? `Loading pipelines in this ${containerLabel}…` : 'Preparing your pipeline…'}
          </MessageBarTitle>
          {rebinding
            ? 'Listing the pipelines available to re-map this item to.'
            : `Loom is connecting this item to its Azure ${containerLabel} pipeline — creating it if it doesn’t exist yet. This happens automatically; there is nothing to configure.`}
        </MessageBarBody>
      </MessageBar>
      <Spinner label={rebinding ? 'Listing pipelines…' : 'Provisioning and binding…'} />
    </>
  );
}

/**
 * A TRANSIENT auto-bind failure (5xx, throttle, timeout, provisioning in
 * flight). Deliberately a retryable progress state rather than a red error
 * banner: the next load settles it on its own, and the manual picker is offered
 * as a secondary escape rather than the only way forward.
 */
export function AutoBindRetry({ containerLabel, reason, onRetry, onRebind }: {
  containerLabel: string;
  reason?: string;
  onRetry: () => void;
  onRebind: () => void;
}) {
  return (
    <MessageBar intent="warning" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>Still connecting this pipeline to Azure</MessageBarTitle>
        Loom is setting up the {containerLabel} pipeline for this item and hit a temporary
        problem. Nothing is lost — retry, or leave this open and it will settle on the next load.
        {reason && (<><br /><Caption1>{reason}</Caption1></>)}
        <div style={actionRow}>
          <Button size="small" appearance="primary" icon={<ArrowSync20Regular />} onClick={onRetry}>
            Retry
          </Button>
          <Button size="small" appearance="secondary" icon={<Link20Regular />} onClick={onRebind}>
            Choose a pipeline manually
          </Button>
        </div>
      </MessageBarBody>
    </MessageBar>
  );
}

/**
 * The user explicitly asked to re-map this item to a different factory or an
 * existing pipeline they authored elsewhere. Reachable ONLY through the Rebind
 * affordance — never the state the editor opens in — so it says so, and offers
 * the way back to the automatic binding.
 */
export function AutoBindRebindNotice({ containerLabel, onCancel }: {
  containerLabel: string;
  onCancel: () => void;
}) {
  return (
    <MessageBar intent="info" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>Re-map this item to a different pipeline</MessageBarTitle>
        Loom already binds this item automatically. Use this only to point it at a specific
        {' '}{containerLabel} or an existing pipeline you authored elsewhere.
        <div style={actionRow}>
          <Button size="small" appearance="secondary" onClick={onCancel}>
            Cancel and use the automatic binding
          </Button>
        </div>
      </MessageBarBody>
    </MessageBar>
  );
}

/**
 * The HONEST GATE (ux-baseline G2). Reached only when the platform genuinely
 * cannot self-serve — the ADF provider looked for a factory in every
 * subscription the Loom identity can read (Resource Graph) and found none, or
 * was denied. `reason` already names the real remediation (deploy the bicep
 * module / grant the identity Reader), never an env var the deploy should have
 * set. The picker rendered beneath this is the in-product Fix-it: point the item
 * at a factory the user CAN reach.
 */
export function AutoBindUnavailable({ reason, onRetry }: {
  reason?: string;
  onRetry: () => void;
}) {
  return (
    <MessageBar intent="warning" layout="multiline" data-testid="pipeline-autobind-gate">
      <MessageBarBody>
        <MessageBarTitle>Loom couldn’t create this pipeline for you</MessageBarTitle>
        {reason}
        <div style={actionRow}>
          <Button size="small" appearance="primary" icon={<ArrowSync20Regular />} onClick={onRetry}>
            Try again
          </Button>
        </div>
      </MessageBarBody>
    </MessageBar>
  );
}

/**
 * The BOUND-BUT-UNSEEDED gate (#3549 review, BLOCKER 1).
 *
 * Auto-bind created a REAL, published pipeline for this item but could not
 * author the item's activity graph into it — an RBAC refusal, or a linked
 * service (typically Databricks) this estate cannot satisfy. The item IS bound
 * and the object DOES exist; only its contents are missing.
 *
 * That combination is precisely what made #3549 invisible for so long: the
 * editor opened on a canvas, reported "0 activities", left **Trigger now**
 * enabled, and warned about nothing. Running it succeeded and did nothing.
 *
 * So this surface is rendered in the BOUND branch — the branch a seedError item
 * actually takes. The unbound branch's starter-graph block never sees it. It
 * carries an inline **Retry seeding** Fix-it per `ux-baseline.md` G2 rather
 * than a bare complaint, because a re-run genuinely resolves the common cases
 * (a role granted since, a transient control-plane refusal).
 *
 * ---------------------------------------------------------------------------
 * SEQUENCING — what `onRetry` MUST do (#3549 review, SHOULD-FIX 4)
 * ---------------------------------------------------------------------------
 * `onRetry` has to re-run auto-bind AND re-read the pipeline document, in that
 * order. It shipped doing only the first (`() => void loadBinding()`), which
 * looks right and is not:
 *
 *   - `loadBinding` is what makes the SERVER re-seed — the bind GET calls
 *     `autoBindOnOpen`, which repairs an empty backing pipeline — and it
 *     refreshes `autoBind`, so the gate correctly disappears.
 *   - but the spec the CANVAS renders comes from `loadPipeline`, and the effect
 *     that calls it is keyed on `[bound, …]`. `bound` does not change across a
 *     successful reseed (same pipeline, same name), so React bails and the
 *     canvas keeps rendering the pre-seed `activities: []`.
 *
 * Net effect of getting it wrong: the gate vanishes and Run/Debug re-enable
 * over a canvas that still reads "0 activities" — the Fix-it appearing to work
 * while leaving its own surface stale, which is a smaller copy of the #3549
 * defect it exists to close. `loadPipeline` must also be AWAITED after
 * `loadBinding`, or it reads the pipeline as it was BEFORE the reseed.
 */
/**
 * The item's AUTHORED activity graph, rendered read-only at full width.
 *
 * Shared by the two states that need to show a graph the live pipeline does not
 * have, because the difference between them is copy, not structure:
 *
 *   'unbound'  a bundle-installed item not yet bound to anything — "here is what
 *              you are about to push live".
 *   'unseeded' BOUND to a real pipeline that is EMPTY because the seed failed
 *              (#3549) — "this is NOT what the factory is running".
 *
 * Read-only in both: the live canvas is the authoring surface.
 */
export function AuthoredGraphPanel({ containerLabel, preview, variant }: {
  containerLabel: string;
  preview: { properties?: { activities?: unknown[] } } | null;
  variant: 'unbound' | 'unseeded';
}) {
  const s = useStyles();
  const activities: unknown[] = Array.isArray(preview?.properties?.activities)
    ? preview!.properties!.activities!
    : [];
  if (activities.length === 0) return null;
  const unseeded = variant === 'unseeded';
  return (
    <div className={s.graph}>
      <div className={s.graphHead}>
        <Subtitle2>{unseeded ? 'Authored graph — not yet published' : 'Starter graph from this app'}</Subtitle2>
        <Badge appearance="outline">
          {activities.length} activit{activities.length === 1 ? 'y' : 'ies'}
        </Badge>
        <Badge appearance="filled" color={unseeded ? 'warning' : 'informative'}>
          {unseeded ? 'Not live · read-only' : 'Preview · read-only'}
        </Badge>
      </div>
      <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
        {unseeded
          ? (<>This is the activity graph this item carries. It is NOT what the {containerLabel} is
              currently running — the bound pipeline is empty. Use <strong>Retry seeding</strong> above
              once the reason is resolved.</>)
          : (<>This pipeline was installed from an app with a fully built-out activity graph (every
              activity, dependency, and parameter). Bind it to a real {containerLabel} pipeline above
              to push this graph live and enable Save / Run / Validate / Triggers.</>)}
      </Body1>
      <PipelineDesigner
        activities={extractActivities(JSON.stringify(preview)) as never}
        parameters={paramsFromSpec(preview as PipelineSpec)}
        variables={varsFromSpec(preview as PipelineSpec)}
        onActivitiesChange={() => { /* read-only */ }}
      />
    </div>
  );
}

export function PipelineSeedIncomplete({ containerLabel, reason, preview, onRetry }: {
  containerLabel: string;
  /** The item's authored pipeline document (the bind GET's `preview`). */
  preview: { properties?: { activities?: unknown[] } } | null;
  reason?: string;
  onRetry: () => void;
}) {
  const activities: unknown[] = Array.isArray(preview?.properties?.activities)
    ? preview!.properties!.activities!
    : [];
  return (
    <>
      <MessageBar intent="warning" layout="multiline" data-testid="pipeline-seed-incomplete">
        <MessageBarBody>
          <MessageBarTitle>This pipeline is live but EMPTY — its activities were not published</MessageBarTitle>
          Loom created the {containerLabel} pipeline for this item and bound it, but could not write
          the {activities.length > 0 ? `${activities.length} activit${activities.length === 1 ? 'y' : 'ies'}` : 'activities'}
          {' '}this item already carries into it. The pipeline below is real and running-capable, so a
          run would SUCCEED and do nothing — Run and Debug are disabled until the graph is published.
          The authored graph is shown underneath so you can see exactly what is missing.
          {reason && (<><br /><Caption1>{reason}</Caption1></>)}
          <div style={actionRow}>
            <Button size="small" appearance="primary" icon={<ArrowSync20Regular />} onClick={onRetry}>
              Retry seeding
            </Button>
          </div>
        </MessageBarBody>
      </MessageBar>
      <AuthoredGraphPanel containerLabel={containerLabel} preview={preview} variant="unseeded" />
    </>
  );
}

/**
 * BOUND, but the backend has nothing published under that name yet (#2895).
 *
 * An expected, recoverable state rather than a backend failure — the item was
 * bound before the pipeline was ever pushed, or the pipeline was deleted out
 * from under it — so it is a guided WARNING with two inline Fix-its
 * (`ux-baseline.md` G2), never a red bar carrying a stringified response body.
 * The canvas below it still renders and is authorable: **Save** creates the
 * pipeline under this name.
 *
 * Lives here rather than in `pipeline-editor-core.tsx` for the same reason as
 * its five siblings above — it is one of the states an item passes through
 * while the platform binds its backing pipeline, it is purely presentational,
 * and the core is at the monolith-creep ceiling.
 */
export function PipelineMissingGate({ containerLabel, bound, onRebind, onRetry }: {
  containerLabel: string;
  /** The name the item is bound to — the name that has nothing behind it. */
  bound: string | null;
  onRebind: () => void;
  onRetry: () => void;
}) {
  return (
    <MessageBar intent="warning" layout="multiline" data-testid="pipeline-missing-gate">
      <MessageBarBody>
        <MessageBarTitle>Nothing published under this name yet</MessageBarTitle>
        This item is bound to a pipeline named <strong>{bound}</strong>, but the{' '}
        {containerLabel} doesn&apos;t have one by that name yet — it was never
        published, or it was deleted. Build the pipeline on the canvas below and{' '}
        <strong>Save</strong> to create it, or rebind this item to a different pipeline.
        <div style={actionRow}>
          <Button size="small" appearance="primary" icon={<Link20Regular />} onClick={onRebind}>
            Rebind or create
          </Button>
          <Button size="small" appearance="secondary" icon={<ArrowSync20Regular />} onClick={onRetry}>
            Retry
          </Button>
        </div>
      </MessageBarBody>
    </MessageBar>
  );
}

/**
 * The LAST-RESORT surface, not the default one. Auto-bind establishes the
 * binding before the editor renders, so the only way here is a console that
 * predates auto-bind (an older image whose bind GET returns no `autoBind`
 * field) — a genuine gate and a transient failure each have their own surface.
 * It therefore leads with the Retry that re-runs auto-bind, and only then offers
 * the manual picker below.
 */
export function AutoBindFallbackGate({ containerLabel, listError, onRetry }: {
  containerLabel: string;
  listError?: string | null;
  onRetry: () => void;
}) {
  return (
    <MessageBar intent="warning" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>Still connecting this pipeline to Azure</MessageBarTitle>
        Loom binds this item to its {containerLabel} pipeline automatically — creating it if it
        doesn’t exist yet. If that hasn’t completed, retry; you can also pick an existing
        pipeline below.
        {listError && (<><br /><strong>Listing pipelines failed:</strong> {listError}</>)}
        <div style={actionRow}>
          <Button size="small" appearance="primary" icon={<ArrowSync20Regular />} onClick={onRetry}>
            Retry
          </Button>
        </div>
      </MessageBarBody>
    </MessageBar>
  );
}
