'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Badge, Button, Subtitle2, Caption1, Spinner,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Database20Regular, DataArea20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import type { RibbonTab } from '@/lib/components/ribbon';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { useStyles } from './styles';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import { openCopilot } from '@/lib/components/copilot-pane';

const DATAMART_MIGRATION_LEARN =
  'https://learn.microsoft.com/power-bi/transform-model/datamarts/datamarts-migrate-to-fabric';

interface DatamartMigration {
  status?: string;
  migratedAt?: string;
  synapseDatabase?: string;
  serverlessEndpoint?: string;
  aasServer?: string;
  aasConnectionUri?: string;
  aasProvisioningState?: string;
  aasAdminWarning?: string;
}

interface DatamartMigrateResult {
  ok: boolean;
  synapseDatabase?: string;
  serverlessEndpoint?: string;
  aasServer?: string;
  aasConnectionUri?: string;
  aasProvisioningState?: string;
  migratedAt?: string;
  aasAdminWarning?: string;
  error?: string;
  code?: string;
}

export function DatamartEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // Datamarts are deprecated — `new` is a hard no-create surface.
  const isNew = id === 'new';

  const [detail, setDetail] = useState<{ displayName?: string; migration?: DatamartMigration } | null>(null);
  const [migrateResult, setMigrateResult] = useState<DatamartMigrateResult | null>(null);
  const [migrating, setMigrating] = useState(false);

  const loadDetail = useCallback(async () => {
    if (isNew) return;
    try {
      const r = await clientFetch(`/api/cosmos-items/datamart/${encodeURIComponent(id)}`);
      const j = await r.json();
      // GET returns the item record directly (not wrapped).
      if (r.ok && j?.id) {
        setDetail({ displayName: j.displayName, migration: (j.state as any)?.migration });
      }
    } catch { /* honest empty state below */ }
  }, [id, isNew]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const migrate = useCallback(async () => {
    if (isNew || migrating) return;
    setMigrating(true); setMigrateResult(null);
    try {
      const r = await clientFetch('/api/items/datamart/migrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ datamartId: id }),
      });
      const j = (await r.json()) as DatamartMigrateResult;
      setMigrateResult(j);
      if (j.ok) loadDetail();
    } catch (e: any) {
      setMigrateResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setMigrating(false);
    }
  }, [id, isNew, migrating, loadDetail]);

  const alreadyMigrated = detail?.migration?.status === 'migrated' || !!migrateResult?.ok;
  const migrateDisabled = isNew || migrating || alreadyMigrated;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Migration', actions: [
        {
          label: migrating ? 'Migrating…' : alreadyMigrated ? 'Migrated' : 'Migrate to Synapse + AAS',
          icon: <ArrowSync20Regular />,
          onClick: migrateDisabled ? undefined : migrate,
          disabled: migrateDisabled,
          title: isNew
            ? 'Datamarts are deprecated — no new items can be created.'
            : alreadyMigrated
              ? 'This datamart has already been migrated.'
              : 'Provision a Synapse Serverless database + Azure Analysis Services server.',
        },
      ]},
    ]},
  ], [isNew, migrating, alreadyMigrated, migrateDisabled, migrate]);

  const liveMigration = detail?.migration?.status === 'migrated' ? detail.migration : undefined;

  // SC-9 — publish the ribbon's Migrate action to the shared command registry so
  // the in-ribbon command search / palette surfaces it with zero duplication.
  useRegisterRibbonCommands(ribbon, 'datamart');

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} commandSearch main={
      <div className={s.pad}>
        {/* SC-6 teaching banner — explain the deprecation + the Azure-native
            migration outcome (Synapse Serverless warehouse + Azure Analysis
            Services semantic model, no Fabric/Power BI capacity). Dismissible. */}
        <TeachingBanner
          surfaceKey="datamart-migration"
          title="Datamarts migrate to Azure-native analytics"
          message="Power BI datamarts are deprecated. Loom migrates each one to a Synapse Serverless warehouse plus an Azure Analysis Services semantic model — no Fabric or Power BI capacity required. Nothing is created here; existing datamarts are migrated in place."
          learnMoreHref={DATAMART_MIGRATION_LEARN}
          learnMoreLabel="Datamart migration guidance"
        />

        {/* Always-visible deprecation banner — datamart is a MIGRATION TEMPLATE, not a creatable editor.
            The "Deprecated" badge renders in every state (new / loading / existing) so the migration
            framing is unmistakable. deprecated:true keeps this item out of the New-item gallery. */}
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>
              Datamarts are deprecated{' '}
              <Badge appearance="outline" color="warning">Deprecated</Badge>
            </MessageBarTitle>
            Migration template — migrate to a Synapse Serverless warehouse + Azure Analysis Services
            semantic model. No Fabric or Power BI capacity is required.
          </MessageBarBody>
          {!isNew && !alreadyMigrated && (
            <MessageBarActions>
              <Button appearance="primary" size="small" onClick={migrate} disabled={migrating}>
                {migrating ? 'Migrating…' : 'Migrate'}
              </Button>
            </MessageBarActions>
          )}
        </MessageBar>

        {/* No-create gate — a guided launcher (SC-4) instead of a bare error.
            Datamarts cannot be created; guide the user to the two Azure-native
            replacements with real create routes, plus an Ask-Copilot path. */}
        {isNew && (
          <GuidedEmptyState
            title="Datamarts are deprecated — pick a replacement"
            intro="Power BI datamarts can no longer be created in Loom. Start with one of the Azure-native replacements below, then migrate any existing datamart's data into it."
            heroIcon={Database20Regular}
            paths={[
              {
                key: 'warehouse',
                title: 'Create a Warehouse',
                body: 'A Synapse Serverless SQL warehouse — the T-SQL analytics store that replaces the datamart. No Fabric capacity needed.',
                icon: Database20Regular,
                href: '/items/warehouse/new',
              },
              {
                key: 'semantic-model',
                title: 'Create a Semantic model',
                body: 'An Azure Analysis Services tabular model — the reusable measures/relationships layer datamarts bundled. No Power BI capacity needed.',
                icon: DataArea20Regular,
                href: '/items/semantic-model/new',
              },
            ]}
            askCopilot={{
              onClick: () => openCopilot(),
              label: 'Ask Copilot which replacement fits',
              body: 'Describe how you used the datamart and Copilot recommends a Warehouse, a Semantic model, or both.',
            }}
            learnMoreHref={DATAMART_MIGRATION_LEARN}
            learnMoreLabel="Datamart migration guidance"
          />
        )}

        {/* Existing item header */}
        {!isNew && detail && (
          <div className={s.card}>
            <div className={s.toolbar}>
              <Subtitle2>{detail.displayName || item.displayName}</Subtitle2>
              <Badge appearance="outline" color="warning">Deprecated</Badge>
              {alreadyMigrated && <Badge appearance="filled" color="success">Migrated</Badge>}
            </div>
            <Caption1>
              Migration provisions a Synapse Serverless database (<code>CREATE DATABASE</code>) and an Azure
              Analysis Services tabular server. No Fabric or Power BI capacity is required.
            </Caption1>
          </div>
        )}

        {/* In-progress */}
        {migrating && (
          <Spinner size="small" labelPosition="after"
            label="Provisioning Synapse Serverless DB + Azure Analysis Services server…" />
        )}

        {/* Fresh migration receipt */}
        {migrateResult?.ok && (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Migration complete</MessageBarTitle>
              Synapse database <strong>{migrateResult.synapseDatabase}</strong> on{' '}
              <code>{migrateResult.serverlessEndpoint}</code>.<br />
              AAS server <strong>{migrateResult.aasServer}</strong> ({migrateResult.aasProvisioningState}).<br />
              Connection: <code>{migrateResult.aasConnectionUri}</code><br />
              Migrated at {migrateResult.migratedAt}.
              {migrateResult.aasAdminWarning && (
                <><br /><em>{migrateResult.aasAdminWarning}</em></>
              )}
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Migration error */}
        {migrateResult && !migrateResult.ok && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Migration failed{migrateResult.code ? ` (${migrateResult.code})` : ''}</MessageBarTitle>
              {migrateResult.error}
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Persisted receipt from Cosmos (when not showing a fresh one) */}
        {!migrating && !migrateResult && liveMigration && (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Already migrated{liveMigration.migratedAt ? ` (${liveMigration.migratedAt})` : ''}</MessageBarTitle>
              Synapse database <strong>{liveMigration.synapseDatabase}</strong>
              {liveMigration.serverlessEndpoint && <> on <code>{liveMigration.serverlessEndpoint}</code></>}.<br />
              AAS server <strong>{liveMigration.aasServer}</strong>
              {liveMigration.aasProvisioningState ? ` (${liveMigration.aasProvisioningState})` : ''}.<br />
              Connection: <code>{liveMigration.aasConnectionUri}</code>
              {liveMigration.aasAdminWarning && (
                <><br /><em>{liveMigration.aasAdminWarning}</em></>
              )}
            </MessageBarBody>
          </MessageBar>
        )}
      </div>
    } />
  );
}
