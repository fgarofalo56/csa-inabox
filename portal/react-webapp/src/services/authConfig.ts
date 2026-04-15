/**
 * MSAL (Microsoft Authentication Library) configuration.
 * Supports both Azure Commercial and Azure Government.
 */

import { Configuration, LogLevel } from '@azure/msal-browser';

const isGov = process.env.NEXT_PUBLIC_AZURE_CLOUD === 'usgovernment';

export const msalConfig: Configuration = {
  auth: {
    clientId: process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID || '',
    authority: isGov
      ? `https://login.microsoftonline.us/${process.env.NEXT_PUBLIC_AZURE_AD_TENANT_ID}`
      : `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_AZURE_AD_TENANT_ID}`,
    redirectUri: process.env.NEXT_PUBLIC_AZURE_AD_REDIRECT_URI || 'http://localhost:3000',
    postLogoutRedirectUri: '/',
    knownAuthorities: isGov
      ? ['login.microsoftonline.us']
      : ['login.microsoftonline.com'],
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        switch (level) {
          case LogLevel.Error:
            console.error(message);
            break;
          case LogLevel.Warning:
            console.warn(message);
            break;
          default:
            break;
        }
      },
      logLevel: LogLevel.Warning,
    },
  },
};

export const loginRequest = {
  scopes: ['User.Read', 'openid', 'profile', 'email'],
};

export const apiRequest = {
  scopes: [
    `api://${process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID}/access_as_user`,
  ],
};
