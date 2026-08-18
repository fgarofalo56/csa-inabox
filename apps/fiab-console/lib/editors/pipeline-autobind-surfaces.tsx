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
  Button, Caption1, MessageBar, MessageBarBody, MessageBarTitle, Spinner, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Link20Regular } from '@fluentui/react-icons';

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
 */
export function PipelineSeedIncomplete({ containerLabel, reason, activityCount, onRetry }: {
  containerLabel: string;
  reason?: string;
  /** How many activities the item's authored graph declares. */
  activityCount: number;
  onRetry: () => void;
}) {
  return (
    <MessageBar intent="warning" layout="multiline" data-testid="pipeline-seed-incomplete">
      <MessageBarBody>
        <MessageBarTitle>This pipeline is live but EMPTY — its activities were not published</MessageBarTitle>
        Loom created the {containerLabel} pipeline for this item and bound it, but could not write
        the {activityCount > 0 ? `${activityCount} activit${activityCount === 1 ? 'y' : 'ies'}` : 'activities'}
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
