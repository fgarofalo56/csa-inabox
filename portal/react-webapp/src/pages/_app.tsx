/**
 * App Layout — Shell with navigation sidebar and main content area.
 * MSAL authentication wraps the entire application.
 * Auth gating is controlled by the `NEXT_PUBLIC_AUTH_ENABLED` env var
 * (see `resolveAuthEnabled` below; CSA-0122).
 */

import React, { useState } from 'react';
import type { AppProps } from 'next/app';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PublicClientApplication, EventType } from '@azure/msal-browser';
import {
  MsalProvider,
  AuthenticatedTemplate,
  UnauthenticatedTemplate,
  useMsal,
} from '@azure/msal-react';
import { msalConfig, loginRequest, resolveAuthEnabled } from '@/services/authConfig';
import { Layout } from '@/components/Layout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import api from '@/services/api';
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

// Bind the MSAL instance to the API client so it can acquire tokens
api.setMsalInstance(msalInstance);

// ─── Auth Gating ──────────────────────────────────────────────────────────

const isAuthEnabled = resolveAuthEnabled();

function LoginPage() {
  const { instance } = useMsal();

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">CSA-in-a-Box</h1>
        <p className="mt-2 text-sm text-gray-500">
          Sign in to access the Data Onboarding Portal
        </p>
        <button
          onClick={() => instance.loginRedirect(loginRequest)}
          className="mt-6 w-full inline-flex justify-center items-center px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-md hover:bg-brand-700"
        >
          Sign in with Microsoft
        </button>
      </div>
    </div>
  );
}

function AuthGatedContent({ children }: { children: React.ReactNode }) {
  if (!isAuthEnabled) {
    return <>{children}</>;
  }

  return (
    <>
      <AuthenticatedTemplate>{children}</AuthenticatedTemplate>
      <UnauthenticatedTemplate>
        <LoginPage />
      </UnauthenticatedTemplate>
    </>
  );
}

// ─── App Component ────────────────────────────────────────────────────────

export default function App({ Component, pageProps }: AppProps) {
  // QueryClient inside the component so it's per-React-tree (safe for SSR)
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <ErrorBoundary>
      <MsalProvider instance={msalInstance}>
        <QueryClientProvider client={queryClient}>
          <AuthGatedContent>
            <Layout>
              <Component {...pageProps} />
            </Layout>
          </AuthGatedContent>
        </QueryClientProvider>
      </MsalProvider>
    </ErrorBoundary>
  );
}
