'use client';

/**
 * BR-OPENAPI — a self-contained, dependency-free OpenAPI explorer.
 *
 * Fetches the live `/api/openapi.json` and renders it as a browsable reference
 * (tag groups → operation cards with method badge, path, summary, parameters,
 * request/response schemas, and a copy-ready cURL). It is a real Redoc/Swagger
 * substitute built with Fluent v9 + Loom tokens — no external CDN bundle (which
 * the deployment CSP would block, and which isn't in node_modules) and no
 * hand-waved data: every row is derived from the served spec.
 */

import * as React from 'react';
import {
  makeStyles,
  tokens,
  Title3,
  Subtitle2,
  Body1,
  Caption1,
  Badge,
  Spinner,
  MessageBar,
  MessageBarBody,
  Button,
  Divider,
} from '@fluentui/react-components';
import { Copy24Regular, Open16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

interface OpenApiSpec {
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, any>>;
  components?: { schemas?: Record<string, any> };
}

interface Operation {
  method: string;
  path: string;
  op: any;
  tag: string;
}

const METHOD_COLOR: Record<string, 'success' | 'brand' | 'warning' | 'danger' | 'informative'> = {
  get: 'success',
  post: 'brand',
  put: 'warning',
  patch: 'warning',
  delete: 'danger',
};

const useStyles = makeStyles({
  root: { display: 'flex', gap: tokens.spacingHorizontalXL, alignItems: 'flex-start', minWidth: 0 },
  side: {
    position: 'sticky',
    top: '0',
    flex: '0 0 200px',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    paddingRight: tokens.spacingHorizontalM,
  },
  sideLink: {
    textAlign: 'left',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    background: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase300,
    ':hover': { background: tokens.colorNeutralBackground1Hover, color: tokens.colorNeutralForeground1 },
  },
  main: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXL },
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalL,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  opHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  path: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: tokens.fontSizeBase200 },
  th: { textAlign: 'left', padding: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  td: { padding: tokens.spacingVerticalXS, borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, verticalAlign: 'top' },
  code: { fontFamily: tokens.fontFamilyMonospace },
  curl: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
    overflowX: 'auto',
    whiteSpace: 'pre',
    margin: 0,
  },
  curlRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start' },
  respRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'baseline', flexWrap: 'wrap' },
});

function slug(tag: string): string {
  return 'tag-' + tag.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function refName(schema: any): string | null {
  if (schema && typeof schema.$ref === 'string') return schema.$ref.replace('#/components/schemas/', '');
  if (schema && schema.type === 'array' && schema.items?.$ref) return schema.items.$ref.replace('#/components/schemas/', '') + '[]';
  return null;
}

export function ApiExplorer(): React.ReactElement {
  const s = useStyles();
  const [spec, setSpec] = React.useState<OpenApiSpec | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await clientFetch('/api/openapi.json');
        if (!res.ok) throw new Error(`spec fetch failed: ${res.status}`);
        const json = (await res.json()) as OpenApiSpec;
        if (live) setSpec(json);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>Could not load the API specification: {error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (!spec) return <Spinner label="Loading the Loom API specification…" />;

  const server = spec.servers?.[0]?.url || '';
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const tag = (op as any).tags?.[0] || 'Other';
      operations.push({ method, path, op, tag });
    }
  }
  const tags = spec.tags?.map((t) => t.name) ?? [...new Set(operations.map((o) => o.tag))];

  return (
    <div className={s.root}>
      <nav className={s.side} aria-label="API sections">
        {tags.map((t) => (
          <button key={t} className={s.sideLink} onClick={() => document.getElementById(slug(t))?.scrollIntoView({ behavior: 'smooth' })}>
            {t}
          </button>
        ))}
        <Divider style={{ margin: `${tokens.spacingVerticalS} 0` }} />
        <a className={s.sideLink} href="/api/openapi.json" target="_blank" rel="noreferrer">
          openapi.json <Open16Regular />
        </a>
      </nav>

      <div className={s.main}>
        <div>
          <Title3 as="h2">{spec.info.title}</Title3>{' '}
          <Badge appearance="tint" color="brand">v{spec.info.version}</Badge>
          <Caption1 as="p" style={{ marginTop: tokens.spacingVerticalXS }}>
            Base URL <span className={s.code}>{server}</span> — authenticate with a cookie session or an{' '}
            <span className={s.code}>Authorization: Bearer loom_pat_…</span> token.
          </Caption1>
        </div>

        {tags.map((tag) => {
          const ops = operations.filter((o) => o.tag === tag);
          if (!ops.length) return null;
          const tagDesc = spec.tags?.find((t) => t.name === tag)?.description;
          return (
            <section key={tag} id={slug(tag)} className={s.group}>
              <div>
                <Subtitle2 as="h3">{tag}</Subtitle2>
                {tagDesc && <Caption1 as="p">{tagDesc}</Caption1>}
              </div>
              {ops.map((o) => (
                <OperationCard key={`${o.method}-${o.path}`} op={o} server={server} styles={s} schemas={spec.components?.schemas} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function OperationCard({
  op,
  server,
  styles: s,
  schemas,
}: {
  op: Operation;
  server: string;
  styles: ReturnType<typeof useStyles>;
  schemas?: Record<string, any>;
}): React.ReactElement {
  const params: any[] = op.op.parameters ?? [];
  const reqSchema = op.op.requestBody?.content?.['application/json']?.schema
    ?? op.op.requestBody?.content?.['application/scim+json']?.schema;
  const responses: Record<string, any> = op.op.responses ?? {};
  const curl = buildCurl(op, server);

  return (
    <div className={s.card}>
      <div className={s.opHeader}>
        <Badge appearance="filled" color={METHOD_COLOR[op.method] ?? 'informative'}>{op.method.toUpperCase()}</Badge>
        <span className={s.path}>{op.path}</span>
      </div>
      {op.op.summary && <Body1>{op.op.summary}</Body1>}
      {op.op.description && <Caption1>{op.op.description}</Caption1>}

      {params.length > 0 && (
        <table className={s.table}>
          <thead>
            <tr>
              <th className={s.th}>Parameter</th>
              <th className={s.th}>In</th>
              <th className={s.th}>Type</th>
              <th className={s.th}>Required</th>
              <th className={s.th}>Description</th>
            </tr>
          </thead>
          <tbody>
            {params.map((p) => (
              <tr key={`${p.in}-${p.name}`}>
                <td className={s.td}><span className={s.code}>{p.name}</span></td>
                <td className={s.td}>{p.in}</td>
                <td className={s.td}>{p.schema?.type ?? '—'}</td>
                <td className={s.td}>{p.required ? 'yes' : 'no'}</td>
                <td className={s.td}>{p.description ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {reqSchema && (
        <Caption1>
          Request body: <span className={s.code}>{refName(reqSchema) ?? reqSchema.type ?? 'object'}</span>
          {schemas && refName(reqSchema) && <SchemaFields name={refName(reqSchema)!.replace('[]', '')} schemas={schemas} styles={s} />}
        </Caption1>
      )}

      <div>
        <Caption1 as="p" style={{ marginBottom: tokens.spacingVerticalXXS }}>Responses</Caption1>
        {Object.entries(responses).map(([code, r]) => {
          const rs = r.content?.['application/json']?.schema ?? r.content?.['application/scim+json']?.schema;
          return (
            <div key={code} className={s.respRow}>
              <Badge size="small" appearance="outline" color={code.startsWith('2') ? 'success' : code.startsWith('4') ? 'warning' : 'danger'}>{code}</Badge>
              <Caption1>{r.description}{refName(rs) ? ` — ${refName(rs)}` : ''}</Caption1>
            </div>
          );
        })}
      </div>

      <div className={s.curlRow}>
        <pre className={s.curl}>{curl}</pre>
        <Button
          size="small"
          appearance="subtle"
          icon={<Copy24Regular />}
          aria-label="Copy cURL"
          onClick={() => { void navigator.clipboard?.writeText(curl); }}
        />
      </div>
    </div>
  );
}

function SchemaFields({ name, schemas, styles: s }: { name: string; schemas: Record<string, any>; styles: ReturnType<typeof useStyles> }): React.ReactElement | null {
  const schema = schemas[name];
  if (!schema?.properties) return null;
  const required: string[] = schema.required ?? [];
  return (
    <table className={s.table} style={{ marginTop: tokens.spacingVerticalXS }}>
      <thead>
        <tr>
          <th className={s.th}>Field</th>
          <th className={s.th}>Type</th>
          <th className={s.th}>Required</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries<any>(schema.properties).map(([field, def]) => (
          <tr key={field}>
            <td className={s.td}><span className={s.code}>{field}</span></td>
            <td className={s.td}>{def.type ?? refName(def) ?? 'object'}</td>
            <td className={s.td}>{required.includes(field) ? 'yes' : 'no'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function buildCurl(op: Operation, server: string): string {
  const base = server === '/' ? '' : server.replace(/\/+$/, '');
  const isScim = op.path.startsWith('/api/scim');
  const authHeader = isScim
    ? "-H 'Authorization: Bearer $LOOM_SCIM_TOKEN'"
    : "-H 'Authorization: Bearer $LOOM_TOKEN'";
  const lines = [`curl -X ${op.method.toUpperCase()} '${base}${op.path}' \\`, `  ${authHeader}`];
  if (['post', 'put', 'patch'].includes(op.method)) {
    lines[1] += ' \\';
    lines.push(`  -H 'Content-Type: application/json' \\`, `  -d '{ }'`);
  }
  return lines.join('\n');
}
