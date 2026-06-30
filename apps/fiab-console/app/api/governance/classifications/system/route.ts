/**
 * GET /api/governance/classifications/system
 *
 * Microsoft Purview ships ~200 BUILT-IN ("system") classifications — the
 * sensitive-information types it auto-detects on a scan (Government IDs, credit
 * cards, SSNs, addresses, email, secrets, health identifiers, …). They are
 * read live from the Purview scan plane (listClassificationRules → the rules
 * whose kind is "System") and grouped into operator-friendly categories so the
 * admin Classifications page can surface them as a read-only catalog and offer
 * them in the rule-authoring dropdown.
 *
 * Real REST: GET {account}.purview.azure.com/scan/classificationrules
 *   https://learn.microsoft.com/rest/api/purview/scanningdataplane/classification-rules
 *
 * Honest gate (no-vaporware): when LOOM_PURVIEW_ACCOUNT is unset this returns
 * { ok:true, configured:false, groups:[] } + the bicep/role remediation hint —
 * never a mock list.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listClassificationRules,
  isPurviewConfigured,
  getPurviewAccountName,
  notConfiguredHint,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SystemClassification {
  name: string;
  classificationName: string;
  displayName: string;
  description?: string;
}
interface ClassificationGroup {
  id: string;
  label: string;
  description: string;
  classifications: SystemClassification[];
}

/** Operator-friendly buckets keyed on the 2nd segment of the classification id. */
const GROUP_DEFS: { id: string; label: string; description: string; keys: string[] }[] = [
  { id: 'government', label: 'Government IDs', description: 'Passport, driver licence, national / tax IDs and social-security numbers.', keys: ['GOVERNMENT'] },
  { id: 'financial', label: 'Financial', description: 'Credit-card, bank-account, SWIFT and other financial identifiers.', keys: ['FINANCIAL'] },
  { id: 'pii', label: 'PII / Personal', description: 'Names, addresses, phone numbers, email and other personal data.', keys: ['PERSONAL'] },
  { id: 'security', label: 'Security & credentials', description: 'Secrets, keys, tokens and other credentials.', keys: ['SECURITY'] },
  { id: 'health', label: 'Health', description: 'Health and medical identifiers.', keys: ['HEALTH', 'MEDICAL'] },
];
const OTHER = { id: 'other', label: 'Other', description: 'Additional built-in sensitive-information types.' };

/** System classification ids look like MICROSOFT.<CATEGORY>.<TYPE> — return CATEGORY. */
function categoryOf(classificationName: string): string {
  const parts = (classificationName || '').split('.');
  return (parts[1] || '').toUpperCase();
}

/** Human-readable label from the trailing segment, e.g. US_SOCIAL_SECURITY_NUMBER → "Us Social Security Number". */
function friendly(classificationName: string): string {
  const parts = (classificationName || '').split('.');
  const last = parts[parts.length - 1] || classificationName || '';
  return last
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || classificationName;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (!isPurviewConfigured()) {
    return NextResponse.json({
      ok: true,
      configured: false,
      account: null,
      groups: [],
      total: 0,
      hint: notConfiguredHint('LOOM_PURVIEW_ACCOUNT'),
    });
  }

  try {
    const rules = await listClassificationRules();
    const system = rules.filter((r) => String((r.raw as any)?.kind || '').toLowerCase() === 'system');

    const groups: Record<string, ClassificationGroup> = {};
    for (const g of [...GROUP_DEFS, OTHER]) {
      groups[g.id] = { id: g.id, label: g.label, description: g.description, classifications: [] };
    }
    for (const r of system) {
      const cn = r.classificationName || r.name;
      const def = GROUP_DEFS.find((g) => g.keys.includes(categoryOf(cn)));
      const gid = def?.id || OTHER.id;
      groups[gid].classifications.push({
        name: r.name,
        classificationName: cn,
        displayName: friendly(cn),
        description: r.description,
      });
    }

    const ordered = [...GROUP_DEFS.map((g) => g.id), OTHER.id]
      .map((id) => groups[id])
      .filter((g) => g.classifications.length > 0)
      .map((g) => ({
        ...g,
        classifications: g.classifications.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      }));

    return NextResponse.json({
      ok: true,
      configured: true,
      account: getPurviewAccountName(),
      groups: ordered,
      total: system.length,
    });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    const status = e instanceof PurviewError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
  }
}
