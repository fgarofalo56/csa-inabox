'use client';

/**
 * CitationChips — renders source links below an assistant turn.
 *
 * Each citation gets a clickable chip:
 *   - kind=docs with url  → opens the published doc page
 *   - kind=repo / no url  → opens the GitHub source on the upstream repo
 *
 * Hover reveals the chunk preview.
 */

import {
  Tooltip, makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Book16Regular, Code16Regular, DocumentBulletList16Regular,
  Lightbulb16Regular, Link16Regular,
} from '@fluentui/react-icons';

export interface Citation {
  id: string;
  path: string;
  kind: string;
  heading?: string;
  url?: string;
  preview: string;
}

const useStyles = makeStyles({
  wrap: {
    display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8,
    paddingTop: 8, borderTop: `1px dashed ${tokens.colorNeutralStroke2}`,
  },
  label: {
    fontSize: 11, color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase', letterSpacing: '0.06em',
    width: '100%', marginBottom: 2, fontWeight: 600,
  },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 12, fontSize: 12,
    color: tokens.colorBrandForeground1, textDecoration: 'none',
    maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    transition: 'background-color 120ms ease, border-color 120ms ease',
    ':hover': {
      backgroundColor: tokens.colorBrandBackground2,
      borderColor: tokens.colorBrandStroke1,
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: 2,
    },
  },
  chipDisabled: {
    cursor: 'default', color: tokens.colorNeutralForeground3,
    ':hover': { backgroundColor: tokens.colorNeutralBackground3 },
  },
});

function iconFor(kind: string) {
  if (kind === 'docs') return <Book16Regular aria-hidden />;
  if (kind === 'repo') return <Code16Regular aria-hidden />;
  if (kind === 'prp') return <DocumentBulletList16Regular aria-hidden />;
  if (kind === 'adr') return <Lightbulb16Regular aria-hidden />;
  return <Link16Regular aria-hidden />;
}

function shortLabel(c: Citation): string {
  if (c.heading) return c.heading;
  const base = c.path.split('/').pop() || c.path;
  return base.replace(/\.(md|tsx?|jsx?)$/, '');
}

const REPO_BASE = 'https://github.com/fgarofalo56/csa-inabox/blob/main';

function hrefFor(c: Citation): string | null {
  if (c.url) return c.url;
  if (c.path) return `${REPO_BASE}/${c.path}`;
  return null;
}

export function CitationChips({ citations }: { citations: Citation[] }) {
  const s = useStyles();
  if (!citations || citations.length === 0) return null;

  return (
    <div className={s.wrap} aria-label="Sources">
      <div className={s.label}>Sources ({citations.length})</div>
      {citations.map((c) => {
        const href = hrefFor(c);
        const Body = (
          <span className={mergeClasses(s.chip, !href && s.chipDisabled)} role="link" tabIndex={href ? 0 : -1}>
            {iconFor(c.kind)}
            <span data-testid="citation-label">{shortLabel(c)}</span>
          </span>
        );
        return (
          <Tooltip
            key={c.id}
            relationship="description"
            content={
              <div style={{ maxWidth: 360 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.path}</div>
                {c.heading && <div style={{ fontStyle: 'italic', marginBottom: 4 }}>{c.heading}</div>}
                <div style={{ fontSize: 12, opacity: 0.9 }}>{c.preview}…</div>
              </div>
            }
          >
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open source ${c.path}`}
                data-testid="citation-chip"
                style={{ textDecoration: 'none' }}
              >
                {Body}
              </a>
            ) : Body}
          </Tooltip>
        );
      })}
    </div>
  );
}
