import type { Metadata } from 'next';
import { Providers } from './providers';
import { AppShell } from '@/lib/components/app-shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'CSA Loom Console',
  description: 'The Microsoft Fabric workspace experience for Azure tenants where Fabric is not yet available.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
