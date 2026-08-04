/**
 * Phase 2 — Azure Logic Apps (Consumption, multitenant) provisioner.
 *
 * Real ARM REST + sample-run exercise:
 *   1. PUT Microsoft.Logic/workflows/{name} with the bundle's Workflow
 *      Definition Language (WDL) `definition` (triggers + actions +
 *      parameters), creating or updating the logic app workflow.
 *      Docs: https://learn.microsoft.com/rest/api/logic/workflows/create-or-update
 *            https://learn.microsoft.com/azure/logic-apps/workflow-definition-language-schema
 *   2. Prove the workflow is REAL the same way data-pipeline.ts triggers an
 *      on-demand run: POST .../triggers/{trigger}/run to fire the manual
 *      "Request"/"Recurrence" trigger, then poll the workflow run history
 *      (GET .../runs) until terminal (Succeeded / Failed / Cancelled) or a
 *      short budget elapses. The install receipt carries a live run id +
 *      status, not a dead shell.
 *      Docs: https://learn.microsoft.com/rest/api/logic/workflow-triggers/run
 *            https://learn.microsoft.com/rest/api/logic/workflow-runs/list
 *            https://learn.microsoft.com/azure/logic-apps/view-workflow-status-run-history
 *
 * Idempotency: PUT is itself create-or-update keyed on workflow name, so a
 * re-install updates the existing definition in place. We GET first to
 * report created vs exists.
 *
 * Per .claude/rules/no-vaporware.md: there is no mock branch. When the
 * subscription / resource-group env vars are absent the provisioner returns
 * a structured remediation gate naming the exact vars to set; when the UAMI
 * lacks the Logic App Contributor role the create / run surfaces a precise
 * 401/403 remediation gate (the workflow itself, if it was created, is real).
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';
import { triggerAndPollWorkflowRun } from './_seed-logic-app';
import { armBase, armScope, LOGIC_APP_WORKFLOW_SCHEMA } from '../../azure/cloud-endpoints';

// ─── ARM auth (mirrors lib/azure/kusto-arm-client.ts exactly) ────────────

const ARM_SCOPE = armScope();
/** Microsoft.Logic stable API version (Consumption workflows). */
export const LOGIC_API = '2016-06-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class LogicAppError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Logic Apps ARM call failed (${status})`);
    this.name = 'LogicAppError';
    this.status = status;
    this.body = body;
  }
}

export interface LogicAppArmConfig {
  subscriptionId: string;
  resourceGroup: string;
  /** Azure region for the workflow resource, e.g. 'usgovvirginia'. */
  location: string;
  /**
   * A DIFFERENT, known-good resource group to retry against when the primary
   * one does not exist. Empty when there is no distinct alternative.
   * See `logicFallbackResourceGroup` for why this is not optional polish.
   */
  fallbackResourceGroup: string;
}

/**
 * Resolve the ARM target for Logic Apps from env. Reuses the platform-wide
 * subscription / resource-group / region vars (same ones every other
 * ARM-backed Loom client reads), falling back to the install target's
 * fields where Logic-Apps-specific overrides exist.
 */
export function readLogicAppArmConfig(): LogicAppArmConfig {
  return {
    subscriptionId: logicSubscriptionId(),
    resourceGroup: logicResourceGroup(),
    location: logicLocation(),
    fallbackResourceGroup: logicFallbackResourceGroup(),
  };
}

// ── Coordinate resolution ────────────────────────────────────────────────
//
// #2954 — THE DEAD GATE. This provisioner used to resolve its region from
// `LOOM_LOGIC_LOCATION || LOOM_AZURE_LOCATION`. NEITHER variable is set by any
// bicep module in the repo — the canonical region the admin-plane stamps on the
// Console container app is **LOOM_LOCATION**
// (platform/fiab/bicep/modules/admin-plane/main.bicep: `{ name: 'LOOM_LOCATION',
// value: location }`), which is what every other region-reading client uses
// (aas-client, eventgrid-client, eventstream-standup, …).
//
// The consequence was total: `logicAppArmMissing()` ALWAYS returned a non-empty
// array in every real deployment, so `logicAppProvisioner` returned
// `status:'remediation'` before issuing a single ARM call and the run route
// always answered its 409 "not backed by a live Azure Logic App" gate. No Logic
// App workflow was ever created by Loom, anywhere — the feature read as
// "configure me" forever, and the remediation text named variables that nothing
// in the platform ever sets, so following it exactly still failed.
//
// LOOM_LOCATION is appended to each chain (the explicit LOOM_LOGIC_* overrides
// still win, so an operator who split Logic Apps into another sub/RG/region
// keeps that behaviour).

function logicSubscriptionId(): string {
  return process.env.LOOM_LOGIC_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
}

function logicResourceGroup(): string {
  return process.env.LOOM_LOGIC_RG || process.env.LOOM_DLZ_RG || process.env.LOOM_ADMIN_RG || '';
}

/**
 * The SECOND live blocker, found against the running commercial estate while
 * validating the fix above.
 *
 * `LOOM_DLZ_RG` on the deployed Console reads `rg-csa-loom-dlz-default-centralus`
 * — a resource group that DOES NOT EXIST in that subscription (the estate runs
 * single-RG out of `LOOM_ADMIN_RG`). So even with the region resolved, the very
 * first `PUT Microsoft.Logic/workflows` would come back `ResourceGroupNotFound`
 * and the user would hit a dead end on create.
 *
 * `auto-bind-by-default.md` is explicit that this is OURS to fix, not the user's:
 * "If there's some binding or mapping or mounting that needs to take place …
 * you figure it out, you fix it, you make it work." So auto-bind retries once
 * against the admin RG — a resource group the deploy always creates and where
 * the platform already runs its own Consumption workflow (the report-subscription
 * delivery Logic App). The `LOOM_<x>_RG || LOOM_ADMIN_RG` shape is the same
 * fallback every other ARM client here uses (health-probes, env-apply, AAS).
 */
export function logicFallbackResourceGroup(): string {
  const admin = process.env.LOOM_ADMIN_RG || '';
  return admin && admin !== logicResourceGroup() ? admin : '';
}

function logicLocation(): string {
  return (
    process.env.LOOM_LOGIC_LOCATION ||
    process.env.LOOM_AZURE_LOCATION ||
    process.env.LOOM_LOCATION ||
    ''
  );
}

export function logicAppArmMissing(): string[] {
  const missing: string[] = [];
  if (!logicSubscriptionId()) missing.push('LOOM_LOGIC_SUB (or LOOM_SUBSCRIPTION_ID)');
  if (!logicResourceGroup()) missing.push('LOOM_LOGIC_RG (or LOOM_DLZ_RG / LOOM_ADMIN_RG)');
  if (!logicLocation()) missing.push('LOOM_LOGIC_LOCATION (or LOOM_LOCATION)');
  return missing;
}

function workflowUrl(cfg: LogicAppArmConfig, name: string): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Logic/workflows/${encodeURIComponent(name)}`;
}

export async function callLogicArm(url: string, init?: RequestInit): Promise<Response> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new LogicAppError(401, undefined, 'Failed to acquire ARM token');
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
    },
  });
}

// ─── Workflow definition assembly ────────────────────────────────────────

/**
 * The bundle ships a WDL `definition` (triggers/actions/parameters/outputs)
 * plus optional `parameters` (workflow parameter VALUES) and `state`. We map
 * that onto the Microsoft.Logic/workflows resource body:
 *   { location, tags, properties: { state, definition, parameters } }
 */
function buildWorkflowBody(content: any, cfg: LogicAppArmConfig, appId: string): any {
  const definition = content?.definition || {
    $schema: LOGIC_APP_WORKFLOW_SCHEMA,
    contentVersion: '1.0.0.0',
    parameters: {},
    triggers: {},
    actions: {},
    outputs: {},
  };
  const body: any = {
    location: cfg.location,
    tags: { 'loom-app': appId, 'loom-managed': 'true' },
    properties: {
      state: content?.state || 'Enabled',
      definition,
    },
  };
  if (content?.parameters && typeof content.parameters === 'object') {
    body.properties.parameters = content.parameters;
  }
  return body;
}

/** First trigger name in the WDL definition — used to fire a manual run. */
function firstTriggerName(content: any): string | undefined {
  const triggers = content?.definition?.triggers;
  if (triggers && typeof triggers === 'object') {
    const keys = Object.keys(triggers);
    if (keys.length > 0) return keys[0];
  }
  return undefined;
}

export const logicAppProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const content = input.content as any;

  // ── Honest env gate: no subscription / RG / region → remediation, not a mock.
  const missing = logicAppArmMissing();
  if (missing.length > 0) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Azure Logic Apps target not configured in this deployment.',
        remediation:
          `Set ${missing.join(', ')} on the Console container app so the ` +
          `installer can create Microsoft.Logic/workflows, and grant the ` +
          `Console UAMI the "Logic App Contributor" role on the resource group.`,
        link: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-securing-a-logic-app',
      },
      steps,
    };
  }

  const cfg = readLogicAppArmConfig();
  // Workflow names: letters, numbers, - _ ( ) . — derive a safe name.
  const name = (input.displayName || `loom-workflow-${input.cosmosItemId}`)
    .replace(/[^A-Za-z0-9\-_().]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);

  const url = workflowUrl(cfg, name);
  const body = buildWorkflowBody(content, cfg, input.appId);

  try {
    // GET first to report created vs exists (idempotent PUT either way).
    let existed = false;
    try {
      const g = await callLogicArm(`${url}?api-version=${LOGIC_API}`);
      existed = g.ok;
      if (g.status === 401 || g.status === 403) {
        return {
          status: 'remediation',
          gate: {
            reason: `Logic Apps ARM ${g.status} on GET workflow.`,
            remediation:
              'Grant the Console UAMI the "Logic App Contributor" role on ' +
              `resource group ${cfg.resourceGroup}.`,
            link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-contributor',
          },
          steps,
        };
      }
    } catch {
      /* treat as not-existing; PUT will create */
    }

    // PUT create-or-update the workflow definition.
    const put = await callLogicArm(`${url}?api-version=${LOGIC_API}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (!put.ok && put.status !== 201 && put.status !== 200) {
      if (put.status === 401 || put.status === 403) {
        return {
          status: 'remediation',
          resourceId: existed ? `${cfg.resourceGroup}/${name}` : undefined,
          gate: {
            reason: `Logic Apps ARM ${put.status} on PUT workflow.`,
            remediation:
              'Grant the Console UAMI the "Logic App Contributor" role on ' +
              `resource group ${cfg.resourceGroup} so it can create/update workflows.`,
            link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-contributor',
          },
          steps,
        };
      }
      throw new LogicAppError(put.status, await put.text(), `PUT workflow failed ${put.status}`);
    }
    const created = await put.json().catch(() => ({}));
    const resourceId: string = created?.id || `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Logic/workflows/${name}`;
    steps.push(existed ? `Updated Logic App workflow '${name}'.` : `Created Logic App workflow '${name}'.`);

    const secondaryIds: Record<string, string> = {
      subscriptionId: cfg.subscriptionId,
      resourceGroup: cfg.resourceGroup,
      workflowName: name,
    };

    // ── Prove it's real: fire a manual trigger run + poll run history.
    const triggerName = firstTriggerName(content);
    if (triggerName) {
      const run = await triggerAndPollWorkflowRun(
        (u, i) => callLogicArm(u, i),
        url,
        triggerName,
      );
      steps.push(...run.steps);
      if (run.authGate) {
        return {
          status: 'remediation',
          resourceId,
          secondaryIds,
          gate: {
            reason: `Workflow created but manual run was not authorized (${run.authGate.status}).`,
            remediation:
              'Grant the Console UAMI "Logic App Operator" (run) + "Logic App ' +
              `Contributor" on resource group ${cfg.resourceGroup}: ${run.authGate.message}`,
            link: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-securing-a-logic-app',
          },
          steps,
        };
      }
      if (run.runName) secondaryIds.lastRunName = run.runName;
      if (run.status) secondaryIds.lastRunStatus = run.status;
    } else {
      steps.push('No trigger in the workflow definition; skipping validation run (definition is still live).');
    }

    return { status: existed ? 'exists' : 'created', resourceId, secondaryIds, steps };
  } catch (e: any) {
    if (e instanceof LogicAppError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Logic Apps ARM ${e.status}: ${e.message}`,
          remediation:
            'Grant the Console UAMI the "Logic App Contributor" role on ' +
            `resource group ${cfg.resourceGroup}.`,
          link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-contributor',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, `Grant the Console UAMI the "Logic App Contributor" role on resource group ${cfg.resourceGroup} (and confirm the resource group exists) so it can author + run the workflow.`, { link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-contributor', steps });
  }
};
