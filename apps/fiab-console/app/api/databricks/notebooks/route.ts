/**
 * Workspace objects (notebooks / folders / files) on the deployment-default
 * Databricks workspace (the Workspace Resources navigator → Notebooks group).
 * Lists a workspace path and creates/deletes notebooks + folders via the real
 * Databricks Workspace REST (api 2.0).
 *
 *   GET    /api/databricks/notebooks?path=/Workspace
 *            → { ok, objects: [{path, object_type, language}] }
 *   POST   /api/databricks/notebooks  body { name, path?, language? }
 *            → import an empty notebook   ( /Workspace/<name> by default )
 *          /api/databricks/notebooks  body { mkdirs:true, path }
 *            → create a folder
 *   DELETE /api/databricks/notebooks?path=/Workspace/foo[&recursive=true]
 *
 * Honest 503 gate when LOOM_DATABRICKS_HOSTNAME is unset. Real REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listWorkspace, importNotebook, mkdirsWorkspace,
  deleteWorkspaceObject,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

const LANGS = new Set(['PYTHON', 'SQL', 'SCALA', 'R']);
const STARTER: Record<string, string> = {
  PYTHON: '# Databricks notebook source\n',
  SQL: '-- Databricks notebook source\n',
  SCALA: '// Databricks notebook source\n',
  R: '# Databricks notebook source\n',
};

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const path = req.nextUrl.searchParams.get('path') || '/Workspace';
  try {
    const raw = await listWorkspace(path);
    const objects = raw.map((o) => ({
      path: o.path,
      // derive a friendly leaf name from the path
      name: o.path.split('/').filter(Boolean).pop() || o.path,
      object_type: o.object_type,
      language: o.language,
    }));
    return NextResponse.json({ ok: true, path, objects });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));

  // Folder create
  if (body?.mkdirs === true) {
    const path: string = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!path) return NextResponse.json({ ok: false, error: 'path is required for mkdirs' }, { status: 400 });
    try {
      await mkdirsWorkspace(path);
      return NextResponse.json({ ok: true, path });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // Notebook import (empty starter)
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  const parent: string = (typeof body?.path === 'string' && body.path.trim()) || '/Workspace';
  const language = (typeof body?.language === 'string' ? body.language.toUpperCase() : 'PYTHON');
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!LANGS.has(language)) return NextResponse.json({ ok: false, error: 'language must be PYTHON|SQL|SCALA|R' }, { status: 400 });
  const nbPath = `${parent.replace(/\/$/, '')}/${name}`;
  try {
    await importNotebook(nbPath, language as any, STARTER[language], false);
    return NextResponse.json({ ok: true, notebook: { path: nbPath, language } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const path = req.nextUrl.searchParams.get('path')?.trim();
  const recursive = req.nextUrl.searchParams.get('recursive') === 'true';
  if (!path) return NextResponse.json({ ok: false, error: 'path query param is required' }, { status: 400 });
  try {
    await deleteWorkspaceObject(path, recursive);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
