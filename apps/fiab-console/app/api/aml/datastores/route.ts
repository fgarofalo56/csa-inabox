/**
 * GET /api/aml/datastores
 *
 * Lists the Azure Machine Learning workspace's datastores (real ARM:
 *   GET .../workspaces/{ws}/datastores?api-version=2024-10-01)
 * and attaches the abfss:// / wasbs:// path the Datastore Explorer drags into
 * a notebook cell.
 *
 * Honest gate: when the AML workspace env isn't configured we return 200 with
 * { ok: false, configured: false, hint } so the editor shows a Fluent
 * MessageBar instead of an error banner. This is the Azure-native default path
 * — no Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listAmlDatastores, amlIsConfigured, amlConfig, AmlNotConfiguredError, AmlError } from '@/lib/azure/aml-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (!amlIsConfigured()) {
    const err = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
    return NextResponse.json(
      { ok: false, configured: false, error: 'Azure ML workspace not configured', hint: err.hint, datastores: [] },
      { status: 200 },
    );
  }

  try {
    const cfg = amlConfig();
    const datastores = await listAmlDatastores();
    return NextResponse.json({
      ok: true,
      configured: true,
      workspace: cfg.workspace,
      datastores: datastores.map((d) => ({
        name: d.name,
        datastoreType: d.datastoreType,
        isDefault: !!d.isDefault,
        accountName: d.accountName,
        containerName: d.containerName,
        filesystem: d.filesystem,
        description: d.description,
        // The draggable insert path: prefer abfss (ADLS Gen2), then wasbs (Blob).
        path: d.abfssPath || d.wasbsPath || null,
        abfssPath: d.abfssPath || null,
        wasbsPath: d.wasbsPath || null,
      })),
    });
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) {
      return NextResponse.json({ ok: false, configured: false, error: e.message, hint: e.hint, datastores: [] }, { status: 200 });
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
