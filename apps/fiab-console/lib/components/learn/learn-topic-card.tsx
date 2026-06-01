'use client';

/**
 * LearnTopicCard — a rich Learn-library card for one topic.
 *
 * A color-tinted icon chip (or a published tutorial thumbnail with a graceful
 * icon fallback) + title + summary + a dual-link footer:
 *   • PRIMARY  → the CSA Loom doc (or MS Learn when no Loom doc exists yet)
 *   • SECONDARY → MS Learn (shown only when a Loom doc is the primary link)
 *
 * When a topic has no Loom doc yet, a small "Loom guide coming" Badge is shown
 * so the gap is honest (per no-vaporware.md) — the primary link still resolves
 * (to Microsoft Learn), never a dead URL.
 */

import * as React from 'react';
import {
  Text, Badge, makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import { Open16Regular, BookOpen16Regular } from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import type { LearnTopic } from '@/lib/learn/content';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
    overflow: 'hidden',
    minWidth: 0,
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    transitionProperty: 'box-shadow, transform, border-color',
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-3px)',
      border: `1px solid ${tokens.colorNeutralStroke1}`,
    },
  },
  // thumbnail band with a tinted gradient backdrop keyed to the family color
  thumbWrap: {
    position: 'relative',
    height: '128px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  // when no image: a centered large icon chip over the tint
  iconArt: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '64px',
    height: '64px',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalL,
    flex: 1,
    minWidth: 0,
  },
  topRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  cat: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1.3,
  },
  summary: {
    color: tokens.colorNeutralForeground2,
    lineHeight: 1.5,
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  links: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalL,
    marginTop: 'auto',
    paddingTop: tokens.spacingVerticalM,
    flexWrap: 'wrap',
  },
  primary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
  secondary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline', color: tokens.colorNeutralForeground2 },
  },
});

export function LearnTopicCard({ topic }: { topic: LearnTopic }): React.ReactElement {
  const s = useStyles();
  const visual = itemVisual(topic.visualType);
  const Icon = visual.icon;
  // Thumbnail can 404 on the published site for some slugs → fall back to icon art.
  const [imgOk, setImgOk] = React.useState<boolean>(!!topic.thumbUrl);

  const showImg = !!topic.thumbUrl && imgOk;

  return (
    <article className={s.card}>
      <div
        className={s.thumbWrap}
        style={{
          background: `linear-gradient(135deg, ${visual.color}26 0%, ${visual.color}0d 100%)`,
        }}
      >
        {showImg ? (
          <img
            className={s.thumbImg}
            src={topic.thumbUrl}
            alt=""
            loading="lazy"
            onError={() => setImgOk(false)}
          />
        ) : (
          <span className={s.iconArt} style={{ color: visual.color }} aria-hidden>
            <Icon style={{ width: 34, height: 34, color: visual.color }} />
          </span>
        )}
      </div>

      <div className={s.body}>
        <div className={s.topRow}>
          <Text size={100} className={s.cat}>{topic.category}</Text>
          {topic.preview && <Badge size="small" appearance="tint" color="warning">Preview</Badge>}
          {!topic.hasLoomDoc && (
            <Badge size="small" appearance="outline" color="informative">Loom guide coming</Badge>
          )}
        </div>

        <Text size={400} className={s.title}>{topic.title}</Text>
        {topic.summary && <Text size={200} className={s.summary}>{topic.summary}</Text>}

        <div className={s.links}>
          <a className={mergeClasses(s.primary)} href={topic.primaryUrl}
             target="_blank" rel="noreferrer">
            <BookOpen16Regular />
            {topic.primaryLabel}
            <Open16Regular />
          </a>
          {topic.hasLoomDoc && topic.msLearnUrl && (
            <a className={s.secondary} href={topic.msLearnUrl} target="_blank" rel="noreferrer">
              MS Learn <Open16Regular />
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

export default LearnTopicCard;
