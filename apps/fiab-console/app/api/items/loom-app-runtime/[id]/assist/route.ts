/**
 * Loom App Runtime — Copilot "describe your app" SCAFFOLDER (APP-W3 slice C).
 *
 * Built on the shared two-phase makeCopilotBuilderRoute (propose → checkpoint
 * → apply → restore). The plan ops write REAL app source:
 *
 *   set-template { templateId }       — switch the runtime starter (real ids only)
 *   set-port     { port }             — container port
 *   write-file   { path, content }    — full file content into state.appRuntime.userFiles
 *                                       (the existing build path overlays these on
 *                                       the template starter — no new build plumbing)
 *
 * Grounding: the REAL template catalog + the app's current files, injected
 * bindings, and attached resources (so generated code reads the actual
 * APP_ONT_* / APP_LH_* / LOOM_* env names, per no-vaporware). AOAI missing →
 * honest 502 gate from the shared route.
 */
import {
  makeCopilotBuilderRoute,
  type BuilderOp,
  type CopilotBuilderConfig,
} from '@/app/api/items/_lib/copilot-builder-route';
import { LOOM_APP_TEMPLATES } from '@/lib/azure/loom-apps-runtime-templates';
import { LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';

interface AppScaffoldDoc {
  templateId: string;
  port: number | undefined;
  userFiles: Record<string, string>;
  envNames: string[];
  resourceLabels: string[];
}

const TEMPLATE_IDS = new Set(LOOM_APP_TEMPLATES.map((t) => t.id));
const MAX_FILE_CHARS = 200_000;

function cleanPath(path: unknown): string {
  const p = String(path || '').replace(/^\.?\/+/, '').trim();
  if (!p || p.includes('..') || p.startsWith('/') || p === 'Dockerfile') return '';
  if (!/^[\w.\-/]+$/.test(p)) return '';
  return p;
}

function makeConfig(): CopilotBuilderConfig<AppScaffoldDoc> {
  return {
    itemType: LOOM_APP_RUNTIME_TYPE,
    docKeys: ['appRuntime'],
    readDoc: (state) => {
      const rt = (state.appRuntime || {}) as Record<string, any>;
      return {
        templateId: typeof rt.templateId === 'string' && rt.templateId ? rt.templateId : 'streamlit',
        port: typeof rt.port === 'number' ? rt.port : undefined,
        userFiles: (rt.userFiles && typeof rt.userFiles === 'object') ? rt.userFiles : {},
        envNames: Array.isArray(rt.env) ? rt.env.map((e: any) => String(e?.name || '')).filter(Boolean) : [],
        resourceLabels: Array.isArray(rt.resources) ? rt.resources.map((r: any) => String(r?.label || '')).filter(Boolean) : [],
      };
    },
    computeStats: (doc) => ({ files: Object.keys(doc.userFiles).length, bindings: doc.envNames.length }),
    systemPrompt:
      'You are the CSA Loom App scaffolder. The user describes a data app in natural language; you emit a ' +
      'JSON edit plan {"summary": string, "ops": [...]} that scaffolds REAL, runnable source for the Loom App ' +
      'Runtime (a container on Azure Container Apps). Allowed ops:\n' +
      '  {"kind":"set-template","templateId":"<one of the catalog ids>"}\n' +
      '  {"kind":"set-port","port":<number>}\n' +
      '  {"kind":"write-file","path":"<relative path>","content":"<FULL file content>"}\n' +
      'Rules: write COMPLETE files (they replace the whole file). The entry file and dependency manifest of ' +
      'the chosen template are the conventional paths (app.py / requirements.txt or server.js / package.json). ' +
      'Read configuration from the injected env vars listed in the context — NEVER hard-code endpoints, keys, ' +
      'or connection strings; azure-identity DefaultAzureCredential resolves the app identity (AZURE_CLIENT_ID ' +
      'is injected). For ontology data the ontology-explorer template ships a loom_ontology module whose EXACT ' +
      'public API is:\n' +
      '  from loom_ontology import attached_ontologies   # -> dict[slug, Ontology] from APP_ONT_* env\n' +
      '  ont = attached_ontologies()["<SLUG>"]           # slug = the env slug, e.g. ENTERPRISE_ONTOLOGY\n' +
      '  ont.object_types                                # list[str] from APP_ONT_<SLUG>_TYPES\n' +
      '  ont.query_objects(type_name, limit=100)         # -> list[dict] of properties (+_id)\n' +
      '  ont.create_object(type_name, props_dict)        # -> created vertex\n' +
      '  ont.traverse(from_type, link_type, limit=100)   # -> [{from, to, to_label}]\n' +
      '  ont.labels()                                    # discover labels in the graph\n' +
      'Use ONLY this API (never invent classes like OntologyClient), and when writing app.py for ' +
      'ontology-explorer do NOT rewrite loom_ontology.py — it ships with the template. Never write a ' +
      'Dockerfile (it is generated). Keep dependencies minimal and pinned.',
    groundingText: (doc) => {
      const catalog = LOOM_APP_TEMPLATES
        .map((t) => `- ${t.id}: ${t.label} (${t.runtime}, port ${t.defaultPort}, entry ${t.entryFile}, manifest ${t.manifestFile})`)
        .join('\n');
      return [
        `Template catalog:\n${catalog}`,
        `Current template: ${doc.templateId}${doc.port ? ` (port ${doc.port})` : ''}`,
        `Current custom files: ${Object.keys(doc.userFiles).join(', ') || '(none — starter files only)'}`,
        `Injected env bindings the app can read: ${doc.envNames.join(', ') || '(none yet)'}`,
        `Attached resources: ${doc.resourceLabels.join('; ') || '(none — the user can attach on the Resources tab)'}`,
      ].join('\n');
    },
    normalizeOps: (rawOps) => {
      const ops: BuilderOp[] = [];
      for (const raw of rawOps as any[]) {
        const kind = String(raw?.kind || '').trim();
        if (kind === 'set-template') {
          const templateId = String(raw?.templateId || '').trim();
          if (!TEMPLATE_IDS.has(templateId)) continue;
          ops.push({ kind, templateId, describe: `Use the '${templateId}' runtime template`, badge: 'Template', badgeColor: 'brand' });
        } else if (kind === 'set-port') {
          const port = Number(raw?.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
          ops.push({ kind, port, describe: `Serve on container port ${port}`, badge: 'Port', badgeColor: 'informative' });
        } else if (kind === 'write-file') {
          const path = cleanPath(raw?.path);
          const content = typeof raw?.content === 'string' ? raw.content : '';
          if (!path || !content || content.length > MAX_FILE_CHARS) continue;
          ops.push({ kind, path, content, describe: `Write ${path} (${content.length.toLocaleString()} chars)`, badge: 'File', badgeColor: 'success' });
        }
      }
      return ops;
    },
    applyOps: (doc, ops, state) => {
      const rt = { ...((state.appRuntime || {}) as Record<string, any>) };
      const userFiles = { ...(rt.userFiles || {}) };
      const applied: string[] = [];
      for (const op of ops) {
        if (op.kind === 'set-template') { rt.templateId = op.templateId; applied.push(op.describe); }
        else if (op.kind === 'set-port') { rt.port = op.port; applied.push(op.describe); }
        else if (op.kind === 'write-file') { userFiles[op.path as string] = op.content as string; applied.push(op.describe); }
      }
      rt.userFiles = userFiles;
      rt.updatedAt = new Date().toISOString();
      return { patch: { appRuntime: rt }, applied, skipped: [] };
    },
    maxCompletionTokens: 4000,
  };
}

export const { GET, POST } = makeCopilotBuilderRoute(makeConfig());
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
