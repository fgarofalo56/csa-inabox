/**
 * Organization reports render BFF.
 *
 * GET /api/org-reports/render?id=<cloneId> → the render model (+ SAMPLE data)
 * for a published report, for any authenticated member. 404 if the report is
 * not published (so unpublishing immediately removes consumer access).
 *
 * Azure-native: renders from the bundled PBIP (real PBIR + TMDL) of the clone's
 * source template — no Microsoft Fabric / Power BI service is contacted.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPublishedReport, getTemplate, getTemplateFiles } from '@/lib/coe-library/coe-library-client';
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

  const id = new URL(req.url).searchParams.get('id')?.trim();
  if (!id) return err('id is required', 400);

  try {
    const clone = await getPublishedReport(id);
    if (!clone) return err('report not found or not published', 404);

    const tpl = getTemplate(clone.templateId);
    if (!tpl) return err(`unknown template: ${clone.templateId}`, 404);

    const files = getTemplateFiles(clone.templateId);
    const model = parseReportModel(files);
    const sample = parseSampleData(files);

    return NextResponse.json({
      ok: true,
      model,
      sample,
      published: true,
      template: {
        id: tpl.id,
        title: clone.displayName || tpl.title,
        description: tpl.description,
        category: clone.category || tpl.category,
      },
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}
