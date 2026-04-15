/**
 * App Layout — Shell with navigation sidebar and main content area.
 * MSAL authentication wraps the entire application.
 */

import React from 'react';
import type { AppProps } from 'next/app';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PublicClientApplication, EventType } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { msalConfig } from '@/services/authConfig';
import { Layout } from '@/components/Layout';
import '@/styles/globals.css';

// ─── MSAL Instance (created once, outside component) ──────────────────────

const msalInstance = new PublicClientApplication(msalConfig);

// Set active account if one already exists (e.g. from session cache)
const accounts = msalInstance.getAllAccounts();
if (accounts.length > 0) {
  msalInstance.setActiveAccount(accounts[0]);
}

// Listen for login success to set the active account automatically
msalInstance.addEventCallback((event) => {
  if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
    const account = (event.payload as { account: ReturnType<typeof msalInstance.getActiveAccount> }).account;
    msalInstance.setActiveAccount(account);
  }
});

// ─── React Query Client ───────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// ─── App Component ────────────────────────────────────────────────────────

export default function App({ Component, pageProps }: AppProps) {
  return (
    <MsalProvider instance={msalInstance}>
      <QueryClientProvider client={queryClient}>
        <Layout>
          <Component {...pageProps} />
        </Layout>
      </QueryClientProvider>
    </MsalProvider>
  );
}
