/**
 * CoE template-render BFF — returns a render-ready report model for the viewer.
 *
 * GET /api/admin/coe-library/render?templateId=<slug>   → render a catalog template
 * GET /api/admin/coe-library/render?cloneId=<cloneId>   → render one of my clones
 *
 * Parses the bundled PBIP files (real PBIR visuals + TMDL SAMPLE data) into
 * { model, sample } the <ReportCanvas> renders. For a cloneId we read the clone
 * doc (per-tenant) to resolve its source templateId and fall back to the bundled
 * template files — the editable PBIP bytes in Blob are identical at clone time,
 * so this avoids a Blob round-trip while staying truthful.
 *
 * Azure-native: no Microsoft Fabric / Power BI service is contacted. Session-gated.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getTemplate, getTemplateFiles, getClone } from '@/lib/coe-library/coe-library-client';
import { parseReportModel } from '@/lib/coe-library/report-render/pbir-parse';
import { parseSampleData } from '@/lib/coe-library/report-render/tmdl-sample';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;

  const url = new URL(req.url);
  const templateId = url.searchParams.get('templateId')?.trim();
  const cloneId = url.searchParams.get('cloneId')?.trim();

  let resolvedTemplateId = templateId || '';
  let published: boolean | undefined;
  let displayName: string | undefined;

  if (cloneId) {
    try {
      const clone = await getClone(tenantId, cloneId);
      if (!clone) return err(`unknown clone: ${cloneId}`, 404);
      resolvedTemplateId = clone.templateId;
      published = !!clone.published;
      displayName = clone.displayName;
    } catch (e: any) {
      return err(e?.message || String(e), 500);
    }
  }

  if (!resolvedTemplateId) return err('templateId or cloneId is required', 400);

  const tpl = getTemplate(resolvedTemplateId);
  if (!tpl) return err(`unknown template: ${resolvedTemplateId}`, 404);

  const files = getTemplateFiles(resolvedTemplateId);
  const model = parseReportModel(files);
  const sample = parseSampleData(files);

  return NextResponse.json({
    ok: true,
    model,
    sample,
    template: {
      id: tpl.id,
      title: displayName || tpl.title,
      description: tpl.description,
      category: tpl.category,
    },
    ...(published !== undefined ? { published } : {}),
  });
}
