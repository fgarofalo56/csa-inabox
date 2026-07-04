'use client';

/**
 * /new — a real destination for the "+ Create" action so deep-links and the
 * Copilot navigate tool (its allow-list is derived from NAV_ITEMS, which now
 * includes /new) resolve to a working surface. It opens the New Item dialog
 * over a Create page; closing it returns Home. In-app, the left-nav "+ Create"
 * entry opens the same dialog inline without a full navigation.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Body1, makeStyles, tokens } from '@fluentui/react-components';
import { PageShell } from '@/lib/components/page-shell';
import { NewItemDialog } from '@/lib/components/new-item-dialog';

const useStyles = makeStyles({
  hint: { color: tokens.colorNeutralForeground3 },
});

export default function NewItemPage() {
  const styles = useStyles();
  const router = useRouter();
  const [open, setOpen] = useState(true);

  return (
    <PageShell
      title="Create"
      subtitle="Pick an item type and the workspace it lands in."
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Create' }]}
    >
      <Body1 className={styles.hint}>Choose an item type to get started.</Body1>
      <NewItemDialog
        hideTrigger
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) router.push('/');
        }}
      />
    </PageShell>
  );
}
