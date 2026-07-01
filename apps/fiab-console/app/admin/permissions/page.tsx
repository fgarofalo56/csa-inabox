'use client';

/**
 * /admin/permissions — Fabric-style RBAC admin surface (two tabs).
 *
 * • Feature permissions — capability tree (Domain → Workload → Capability) on
 *   the left, selected capability's grants on the right. Delegates feature
 *   access via the static capability catalog.
 * • Workspace access — pick any workspace, then manage its members (Admin /
 *   Member / Contributor / Viewer). Each role is the Cosmos system-of-record
 *   mirrored to a REAL Azure RBAC assignment on the workspace's backing
 *   resource group (F9). Tenant admins can manage any workspace.
 *
 * All operations call real BFF routes — no mock state. When the caller lacks
 * the required capability / role, the surface renders an honest MessageBar with
 * the exact remediation.
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Caption1, Body1, Subtitle2, Title2,
  TabList, Tab, Dropdown, Option, Field,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  AddRegular, ShieldKeyhole24Regular, PeopleTeam24Regular, ShieldTask24Regular,
  Organization24Regular, KeyMultiple24Regular, CursorClick24Regular,
} from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { CapabilityTree } from '@/lib/components/feature-rbac/capability-tree';
import { GrantRow } from '@/lib/components/feature-rbac/grant-row';
import { GrantDialog } from '@/lib/components/feature-rbac/grant-dialog';
import { Section } from '@/lib/components/ui/section';
import { EmptyState } from '@/lib/components/empty-state';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { WorkspaceAccessPane } from '@/lib/panes/workspace-access';
import { DomainAccessPane } from '@/lib/panes/domain-access';
import type { Capability } from '@/lib/auth/feature-catalog';
import type { FeatureGrant } from '@/lib/auth/feature-gate';

type PermTab = 'features' | 'workspace-access' | 'domain-access';

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL },
  explainer: { marginBottom: tokens.spacingVerticalL },
  explainerList: { marginTop: tokens.spacingVerticalS, marginBottom: 0, paddingLeft: tokens.spacingHorizontalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  tabs: { marginBottom: tokens.spacingVerticalL },
  layout: {
    display: 'grid',
    gridTemplateColumns: '320px minmax(0, 1fr)',
    minHeight: '600px',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  treePane: {
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    overflow: 'hidden',
    minWidth: 0,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease-in-out',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  detail: {
    padding: tokens.spacingVerticalL,
    overflowY: 'auto',
    minWidth: 0,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease-in-out',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexWrap: 'wrap',
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  grants: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalM },
  wsPicker: { maxWidth: '480px', marginBottom: tokens.spacingVerticalL },
  hidden: { display: 'none' },
  fieldNote: { marginTop: tokens.spacingVerticalXS },
  minW0: { minWidth: 0 },
  capDesc: { display: 'block', marginTop: tokens.spacingVerticalXS, overflowWrap: 'anywhere' },
  capId: {
    display: 'block', marginTop: tokens.spacingVerticalXS,
    fontFamily: 'monospace', color: tokens.colorNeutralForeground3,
    overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
});

export default function PermissionsPage() {
  const styles = useStyles();
  const [tab, setTab] = useState<PermTab>('features');

  return (
    <AdminShell sectionTitle="Permissions">
      <div className={styles.explainer}>
        <SectionExplainer>
          Loom uses two access layers: <strong>feature permissions</strong> (what a user can do in the console) and <strong>workspace / domain access</strong> (which data a user can reach). Both are enforced by a policy decision point (PDP) on every request; tenant admins always have full access.
          <ul className={styles.explainerList}>
            <li>
              <strong>Feature permissions</strong> — a capability tree (Domain → Workload → Capability). Grant a capability to a user or group to delegate that action; the PDP evaluates the grant on each call.{' '}
              <LearnPopover
                title="Feature permissions (PDP)"
                content="Every capability (e.g. “manage scaling”, “publish a data product”) is a node in the catalog. A grant maps a user or Entra group to a capability; the policy decision point checks it server-side on each request, so the UI and the BFF stay in sync."
                learnMoreHref="https://learn.microsoft.com/entra/identity-platform/custom-rbac-for-developers"
              />
            </li>
            <li>
              <strong>Workspace access</strong> — pick a workspace and manage members as <strong>Admin / Member / Contributor / Viewer</strong>. Each role is recorded in Cosmos and mirrored to a real Azure RBAC assignment on the workspace's backing resource group (Admin/Member → Contributor, Contributor/Viewer → Reader).{' '}
              <LearnPopover
                title="Workspace roles → Azure RBAC"
                content="A workspace role is both a Loom record and a real Azure role assignment on the workspace's resource group, so access holds even outside the console. No Microsoft Fabric dependency."
                tips={['Admin / Member → Contributor on the workspace RG', 'Contributor / Viewer → Reader', 'Owner of a workspace can manage its members']}
                learnMoreHref="https://learn.microsoft.com/azure/role-based-access-control/overview"
              />
            </li>
            <li>
              <strong>Tenant admin</strong> — the user in <code>LOOM_TENANT_ADMIN_OID</code> or a member of the <code>LOOM_TENANT_ADMIN_GROUP_ID</code> group always has full access and can manage any workspace or domain — including bootstrapping the first grants before any others exist.{' '}
              <LearnPopover
                title="Tenant admin vs. workspace owner"
                content="A tenant admin (LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID) governs the whole tenant and can act on every workspace. A workspace owner only manages membership and access for their own workspace. Set these env vars in Runtime configuration."
                learnMoreHref="https://learn.microsoft.com/entra/identity/role-based-access-control/custom-overview"
              />
            </li>
          </ul>
        </SectionExplainer>
      </div>

      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_e, d) => setTab(d.value as PermTab)}
      >
        <Tab value="features" icon={<ShieldTask24Regular />}>Feature permissions</Tab>
        <Tab value="workspace-access" icon={<PeopleTeam24Regular />}>Workspace access</Tab>
        <Tab value="domain-access" icon={<Organization24Regular />}>Domain access</Tab>
      </TabList>

      {/* Keep both mounted to preserve each tab's loaded state; hide the inactive one. */}
      <div className={tab === 'features' ? undefined : styles.hidden}>
        <FeaturePermissionsTab styles={styles} />
      </div>
      <div className={tab === 'workspace-access' ? undefined : styles.hidden}>
        <WorkspaceAccessTab styles={styles} active={tab === 'workspace-access'} />
      </div>
      <div className={tab === 'domain-access' ? undefined : styles.hidden}>
        <DomainAccessPane />
      </div>
    </AdminShell>
  );
}

// =========================================================================
// Tab 1 — Feature permissions (capability tree)
// =========================================================================

type Styles = ReturnType<typeof useStyles>;

function FeaturePermissionsTab({ styles }: { styles: Styles }) {
  const [groups, setGroups] = useState<Array<{ domain: string; workloads: Array<{ name: string; capabilities: Capability[] }> }>>([]);
  const [grants, setGrants] = useState<FeatureGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; remediation?: string } | null>(null);
  const [selected, setSelected] = useState<Capability | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [capRes, grantRes] = await Promise.all([
        clientFetch('/api/admin/permissions/capabilities', { cache: 'no-store' }),
        clientFetch('/api/admin/permissions/grants', { cache: 'no-store' }),
      ]);
      if (capRes.status === 401 || capRes.status === 403) {
        const j = await capRes.json().catch(() => ({}));
        setError({ message: `Access denied (${capRes.status})`, remediation: j?.remediation });
        return;
      }
      const capJson = await capRes.json();
      const grantJson = await grantRes.json();
      setGroups(capJson.groups || []);
      setGrants(grantJson.grants || []);
      if (!selected && capJson.groups?.[0]?.workloads?.[0]?.capabilities?.[0]) {
        setSelected(capJson.groups[0].workloads[0].capabilities[0]);
      }
    } catch (e: any) {
      setError({ message: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const grantCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of grants) m[g.capabilityId] = (m[g.capabilityId] || 0) + 1;
    return m;
  }, [grants]);

  const grantsForSelected = useMemo(
    () => grants.filter((g) => g.capabilityId === selected?.id),
    [grants, selected],
  );

  if (loading) {
    return <Section><Spinner label="Loading capability catalog…" /></Section>;
  }
  if (error) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>{error.message}</MessageBarTitle>
          {error.remediation && <div className={styles.fieldNote}>{error.remediation}</div>}
          {!error.remediation && (
            <div className={styles.fieldNote}>
              Only members of the tenant-admin group (env <code>LOOM_TENANT_ADMIN_GROUP_ID</code>) or the user with <code>LOOM_TENANT_ADMIN_OID</code> can manage feature permissions before any grants exist.
            </div>
          )}
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <>
      <Body1 className={styles.intro}>
        Fabric-style RBAC. Pick a capability from the tree, then review and delegate its grants.
        Tenant admins always have full access; explicit grants extend access to others.
      </Body1>
      <Section bare>
        <div className={styles.layout}>
          <div className={styles.treePane}>
            <CapabilityTree
              groups={groups}
              grantCounts={grantCounts}
              selected={selected?.id}
              onSelect={(c) => setSelected(c)}
            />
          </div>
          <div className={styles.detail}>
            {selected ? (
              <>
                <div className={styles.header}>
                  <div className={styles.minW0}>
                    <Title2 className={styles.titleRow}><ShieldKeyhole24Regular /> {selected.name}</Title2>
                    <Caption1 className={styles.capDesc}>{selected.description}</Caption1>
                    <Caption1 className={styles.capId}>
                      {selected.id}
                    </Caption1>
                  </div>
                  <Button appearance="primary" icon={<AddRegular />} onClick={() => setDialogOpen(true)}>
                    Add grant
                  </Button>
                </div>
                <Subtitle2>Current grants ({grantsForSelected.length})</Subtitle2>
                <div className={styles.grants}>
                  {grantsForSelected.length === 0 && (
                    <EmptyState
                      icon={<KeyMultiple24Regular />}
                      title="No grants yet for this capability"
                      body="Tenant admins always have full access. Add an explicit grant to delegate this capability to other users or groups."
                      primaryAction={{ label: 'Add grant', onClick: () => setDialogOpen(true) }}
                    />
                  )}
                  {grantsForSelected.map((g) => (
                    <GrantRow key={g.id} grant={g} onRemoved={load} />
                  ))}
                </div>
              </>
            ) : (
              <EmptyState
                icon={<CursorClick24Regular />}
                title="Select a capability"
                body="Pick a capability from the tree on the left to review and delegate its grants."
              />
            )}
          </div>
        </div>
      </Section>
      <GrantDialog
        open={dialogOpen}
        capabilityId={selected?.id || ''}
        capabilityName={selected?.name || ''}
        onClose={() => setDialogOpen(false)}
        onGranted={load}
      />
    </>
  );
}

// =========================================================================
// Tab 2 — Workspace access (per-workspace RBAC grid, F9)
// =========================================================================

interface WorkspaceSummary { id: string; name: string }

function WorkspaceAccessTab({ styles, active }: { styles: Styles; active: boolean }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedWs, setSelectedWs] = useState<string | null>(null);

  // Lazy-load the workspace inventory the first time this tab is shown.
  useEffect(() => {
    if (!active || workspaces !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await clientFetch('/api/admin/workspaces', { cache: 'no-store' });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.ok) { setError(json?.error || `HTTP ${res.status}`); setWorkspaces([]); return; }
        const list: WorkspaceSummary[] = (json.workspaces || []).map((w: any) => ({ id: w.id, name: w.name || w.id }));
        setWorkspaces(list);
        if (list.length > 0) setSelectedWs(list[0].id);
      } catch (e: any) {
        if (!cancelled) { setError(e?.message || String(e)); setWorkspaces([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [active, workspaces]);

  const selectedName = useMemo(
    () => workspaces?.find((w) => w.id === selectedWs)?.name,
    [workspaces, selectedWs],
  );

  return (
    <>
      <Body1 className={styles.intro}>
        Manage per-workspace membership. Each role is recorded in Cosmos and mirrored to a real
        Azure RBAC assignment on the workspace&apos;s backing resource group — Admin/Member grant
        Contributor, Contributor/Viewer grant Reader. No Microsoft Fabric dependency.
      </Body1>

      {error && (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}

      {workspaces === null && <Spinner size="small" label="Loading workspaces…" />}

      {workspaces && workspaces.length === 0 && !error && (
        <EmptyState
          icon={<PeopleTeam24Regular />}
          title="No workspaces found"
          body="This tenant has no workspaces yet. Create a workspace first, then return here to manage its members and roles."
        />
      )}

      {workspaces && workspaces.length > 0 && (
        <>
          <Field label="Workspace" className={styles.wsPicker}>
            <Dropdown
              value={selectedName || ''}
              selectedOptions={selectedWs ? [selectedWs] : []}
              onOptionSelect={(_e, d) => setSelectedWs(d.optionValue || null)}
              placeholder="Select a workspace"
            >
              {workspaces.map((w) => (
                <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>
              ))}
            </Dropdown>
          </Field>

          <Section bare>
            {selectedWs ? (
              <WorkspaceAccessPane key={selectedWs} workspaceId={selectedWs} workspaceName={selectedName} />
            ) : (
              <EmptyState
                icon={<CursorClick24Regular />}
                title="Select a workspace"
                body="Choose a workspace from the picker above to manage its members and their roles."
              />
            )}
          </Section>
        </>
      )}
    </>
  );
}
