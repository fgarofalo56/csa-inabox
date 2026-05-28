/**
 * Phase 2 — Activator (Reflex) provisioner.
 *
 * Real REST: POST /workspaces/{ws}/reflexes to create the activator
 * item; then POST /reflexes/{id}/triggers for each rule in the bundle.
 *
 * Idempotency: list existing reflexes; if displayName already in the
 * workspace, reuse the id and just push any new rules.
 */
import { listActivators, createActivator, addRule, ActivatorError, listRules } from '@/lib/azure/activator-client';
import type { Provisioner, ProvisionResult } from './types';

export const activatorProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  if (!ws) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No bound Fabric workspace.',
        remediation: 'Bind a Fabric workspace, or set LOOM_DEFAULT_FABRIC_WORKSPACE.',
        link: '/admin/workspaces',
      },
      steps,
    };
  }

  let reflexId: string | undefined;
  let isExisting = false;
  try {
    const existing = await listActivators(ws);
    const match = existing.find((a) => (a.displayName || '').toLowerCase() === input.displayName.toLowerCase());
    if (match?.id) {
      reflexId = match.id;
      isExisting = true;
      steps.push(`Found existing reflex ${match.id}; reusing.`);
    } else {
      const created = await createActivator(ws, { displayName: input.displayName, description: `Installed from ${input.appId}` });
      reflexId = created.id;
      steps.push(`Created reflex ${created.id}.`);
    }
  } catch (e: any) {
    if (e instanceof ActivatorError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Activator ${e.status}: ${e.message}`,
          remediation:
            'Enable tenant setting "Service principals can use Fabric APIs" + add Console UAMI to the Fabric workspace as Contributor.',
          link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    return { status: 'failed', error: e?.message || String(e), steps };
  }

  // Push rule(s) from bundle.
  const content = input.content as any;
  const rules: Array<any> = content?.kind === 'activator' && content.rule
    ? [content.rule]
    : (Array.isArray(content?.rules) ? content.rules : []);
  if (reflexId && rules.length > 0) {
    let existingRuleNames = new Set<string>();
    try {
      const rl = await listRules(ws, reflexId);
      existingRuleNames = new Set(rl.map((r) => (r.name || '').toLowerCase()));
    } catch { /* preview endpoint may 404 — fine */ }

    for (const r of rules) {
      if (existingRuleNames.has((r.name || '').toLowerCase())) {
        steps.push(`Rule '${r.name}' already exists; skipping.`);
        continue;
      }
      try {
        await addRule(ws, reflexId, { name: r.name, condition: r.condition || {}, action: r.action || {} });
        steps.push(`Added rule '${r.name}'.`);
      } catch (e: any) {
        steps.push(`Failed to add rule '${r.name}': ${e?.message || String(e)}`);
      }
    }
  }

  return {
    status: isExisting ? 'exists' : 'created',
    resourceId: reflexId,
    secondaryIds: { fabricWorkspaceId: ws },
    steps,
  };
};
