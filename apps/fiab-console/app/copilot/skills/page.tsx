'use client';

/**
 * /copilot/skills — the Skills Studio surface (CTS-07).
 *
 * Renders the Cosmos-backed skills library: the seeded Microsoft + Power BI
 * built-in skills plus tenant custom skills, each with a per-user toggle, a
 * form-based builder, and a pane sandbox. All behavior lives in the shared
 * <SkillsStudio/> component; this page is the route shell only.
 */

import { makeStyles, tokens } from '@fluentui/react-components';
import { SkillsStudio } from '@/lib/components/copilot/skills-studio/skills-studio';

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    padding: tokens.spacingVerticalXXL,
    paddingTop: tokens.spacingVerticalXL,
    maxWidth: '1280px',
    width: '100%',
    margin: '0 auto',
    boxSizing: 'border-box',
  },
});

export default function CopilotSkillsPage() {
  const styles = useStyles();
  return (
    <div className={styles.page}>
      <SkillsStudio />
    </div>
  );
}
