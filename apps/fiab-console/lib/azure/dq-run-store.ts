/**
 * Cosmos-backed DQ run-history store (`dq-runs:<tenantId>` in tenant-settings).
 * Shared by /api/dq/run (append) and /api/dq/results (read). One doc per tenant;
 * we cap to the most-recent MAX_RUNS so the doc stays well under the 2MB item
 * limit. Real Cosmos reads/writes — no mock history.
 */
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import type { DqRunBackend, DqRuleResult } from '@/lib/azure/data-quality-client';

export interface DqRunRecord {
  id: string;
  backend: DqRunBackend;
  target: string;
  score: number | null;
  ruleCount: number;
  passingRules: number;
  breakdown: DqRuleResult[];
  ranAt: string;
  ranBy: string;
  /** Optional table filter the operator ran against. */
  tables?: string[];
}

interface DqRunsDoc {
  id: string;
  tenantId: string;
  kind: 'dq-runs';
  items: DqRunRecord[];
  updatedAt: string;
}

const MAX_RUNS = 50;
function docId(tenantId: string) { return `dq-runs:${tenantId}`; }

export async function listDqRuns(tenantId: string): Promise<DqRunRecord[]> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(docId(tenantId), tenantId).read<DqRunsDoc>();
    return resource?.items || [];
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}

export async function appendDqRun(tenantId: string, rec: DqRunRecord): Promise<DqRunRecord[]> {
  const c = await tenantSettingsContainer();
  const id = docId(tenantId);
  let doc: DqRunsDoc;
  try {
    const { resource } = await c.item(id, tenantId).read<DqRunsDoc>();
    doc = resource || { id, tenantId, kind: 'dq-runs', items: [], updatedAt: '' };
  } catch (e: any) {
    if (e?.code !== 404) throw e;
    doc = { id, tenantId, kind: 'dq-runs', items: [], updatedAt: '' };
  }
  doc.items = [rec, ...(doc.items || [])].slice(0, MAX_RUNS);
  doc.updatedAt = new Date().toISOString();
  await c.items.upsert<DqRunsDoc>(doc);
  return doc.items;
}
