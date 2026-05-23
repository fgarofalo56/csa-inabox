'use client';

import { FluentProvider, webLightTheme, webDarkTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState(webLightTheme);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setTheme(mql.matches ? webDarkTheme : webLightTheme);
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={theme}>{children}</FluentProvider>
    </QueryClientProvider>
  );
}
